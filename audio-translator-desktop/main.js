const { app, BrowserWindow, ipcMain, screen, desktopCapturer, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');

let mainWindow;
let floatingWindow;
let configPath = path.join(__dirname, 'config.json');
let doubaoWs = null;
let doubaoPingTimer = null;
let originalOutputDeviceName = null;
let didSwitchOutput = false;

const DOUBAO_WS_URL = 'ws://localhost:3000';
const KEYCHAIN_SERVICE = 'audio-translator-desktop';
const KEYCHAIN_ACCOUNT = 'doubao-api-key';
const execFileAsync = promisify(execFile);

async function runCommand(command, args = []) {
  const { stdout } = await execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 8
  });
  return stdout.trim();
}

async function readApiKeyFromKeychain() {
  if (process.platform !== 'darwin') {
    return '';
  }

  try {
    return await runCommand('/usr/bin/security', [
      'find-generic-password',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      KEYCHAIN_ACCOUNT,
      '-w'
    ]);
  } catch (e) {
    return '';
  }
}

async function saveApiKeyToKeychain(apiKey) {
  if (process.platform !== 'darwin') {
    throw new Error('当前仅支持在 macOS Keychain 中安全保存 API Key');
  }

  if (!apiKey) {
    try {
      await runCommand('/usr/bin/security', [
        'delete-generic-password',
        '-s',
        KEYCHAIN_SERVICE,
        '-a',
        KEYCHAIN_ACCOUNT
      ]);
    } catch (e) {
      // Ignore missing Keychain item.
    }
    return;
  }

  await runCommand('/usr/bin/security', [
    'add-generic-password',
    '-s',
    KEYCHAIN_SERVICE,
    '-a',
    KEYCHAIN_ACCOUNT,
    '-w',
    apiKey,
    '-U'
  ]);
}

async function loadConfig() {
  let config = {
    appKey: '',
    resourceId: 'volc.service_type.10053',
    sourceLanguage: 'id',
    targetLanguage: 'zh'
  };

  try {
    if (fs.existsSync(configPath)) {
      config = {
        ...config,
        ...JSON.parse(fs.readFileSync(configPath, 'utf8'))
      };
    }
  } catch (e) {
    console.error('Failed to load config:', e);
  }

  if (Object.prototype.hasOwnProperty.call(config, 'appKey')) {
    try {
      if (config.appKey) {
        await saveApiKeyToKeychain(config.appKey);
      }
      delete config.appKey;
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    } catch (e) {
      console.error('Failed to migrate API Key to Keychain:', e);
    }
  }

  config.appKey = await readApiKeyFromKeychain();
  return config;
}

async function saveConfig(config) {
  try {
    if (Object.prototype.hasOwnProperty.call(config, 'appKey')) {
      await saveApiKeyToKeychain(config.appKey);
    }

    const safeConfig = { ...config };
    delete safeConfig.appKey;
    fs.writeFileSync(configPath, JSON.stringify(safeConfig, null, 2));
  } catch (e) {
    console.error('Failed to save config:', e);
    throw e;
  }
}

function maskSecret(value) {
  if (!value || value.length <= 10) {
    return '***';
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function friendlyError(technicalMessage) {
  const msg = (technicalMessage || '').toLowerCase();
  if (msg.includes('aggregateerror') || msg.includes('econnrefused') || msg.includes('ecONNREFUSED')) {
    return '无法连接翻译服务，请确认代理已启动（端口 3000）';
  }
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key') || msg.includes('45000001')) {
    return 'API Key 无效或已过期，请前往火山引擎控制台重新获取';
  }
  if (msg.includes('403') || msg.includes('forbidden')) {
    return 'API Key 没有权限，请检查 Resource ID 是否正确';
  }
  if (msg.includes('429') || msg.includes('too many requests')) {
    return '请求过于频繁，请稍后重试';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('etimedout')) {
    return '连接超时，请检查网络或代理是否正常';
  }
  if (msg.includes('missing api key')) {
    return '请先填写 API Key';
  }
  if (msg.includes('closed before open') || msg.includes('1006')) {
    return '翻译服务连接异常断开，请检查网络后重试';
  }
  return technicalMessage || '未知错误';
}

function getAudioItems(systemProfilerJson) {
  return systemProfilerJson.SPAudioDataType?.flatMap(group => group._items || []) || [];
}

async function getAudioEnvironment() {
  if (process.platform !== 'darwin') {
    return {
      supported: false,
      message: '当前音频环境检测只支持 macOS'
    };
  }

  try {
    const stdout = await runCommand('/usr/sbin/system_profiler', ['SPAudioDataType', '-json']);
    const items = getAudioItems(JSON.parse(stdout));
    const blackHoleDevices = items.filter(item => /blackhole/i.test(item._name || ''));
    const defaultOutput = items.find(item => item.coreaudio_default_audio_output_device === 'spaudio_yes');
    const hasMultiOutput = Boolean(defaultOutput && /multi-output|多输出/i.test(defaultOutput._name || ''));
    const switchAudioSourceAvailable = await hasSwitchAudioSource();

    if (!originalOutputDeviceName && defaultOutput?._name) {
      originalOutputDeviceName = defaultOutput._name;
    }

    return {
      supported: true,
      blackHoleFound: blackHoleDevices.length > 0,
      blackHoleDevices: blackHoleDevices.map(item => item._name),
      defaultOutputName: defaultOutput?._name || '',
      isDefaultOutputMultiOutput: hasMultiOutput,
      originalOutputDeviceName,
      canAutoRestoreOutput: switchAudioSourceAvailable,
      guide: buildAudioGuide(blackHoleDevices.length > 0, hasMultiOutput, switchAudioSourceAvailable)
    };
  } catch (e) {
    return {
      supported: false,
      message: e.message
    };
  }
}

async function hasSwitchAudioSource() {
  try {
    await runCommand('/usr/bin/which', ['SwitchAudioSource']);
    return true;
  } catch (e) {
    return false;
  }
}

function buildAudioGuide(blackHoleFound, hasMultiOutput, canAutoRestoreOutput) {
  const steps = [];
  if (!blackHoleFound) {
    steps.push('未检测到 BlackHole：请先安装 BlackHole 2ch，并在应用里点击“刷新音频设备”。');
  }
  if (!hasMultiOutput) {
    steps.push('当前系统输出不是多输出设备：打开“音频 MIDI 设置” > 左下角 + > 创建多输出设备，勾选耳机/扬声器和 BlackHole。');
    steps.push('在“系统设置 > 声音 > 输出”里选择刚创建的多输出设备。');
  }
  if (!canAutoRestoreOutput) {
    steps.push('如需退出时自动恢复默认输出，可安装 SwitchAudioSource：brew install switchaudio-osx。未安装时应用只会提示手动恢复。');
  }
  if (steps.length === 0) {
    steps.push('音频环境看起来已就绪。');
  }
  return steps;
}

async function restoreOriginalOutputDevice() {
  if (!originalOutputDeviceName) {
    return { ok: false, message: '没有记录到启动前的默认输出设备' };
  }

  if (!(await hasSwitchAudioSource())) {
    return {
      ok: false,
      message: `未安装 SwitchAudioSource，无法自动恢复。请手动切回：${originalOutputDeviceName}`
    };
  }

  await runCommand('SwitchAudioSource', ['-t', 'output', '-s', originalOutputDeviceName]);
  return { ok: true, outputDeviceName: originalOutputDeviceName };
}

function clearDoubaoPingTimer() {
  if (doubaoPingTimer) {
    clearInterval(doubaoPingTimer);
    doubaoPingTimer = null;
  }
}

function closeDoubaoWs() {
  clearDoubaoPingTimer();
  if (doubaoWs) {
    try {
      doubaoWs.close();
    } catch (e) {
      console.error('Failed to close Doubao WebSocket:', e);
    }
    doubaoWs = null;
  }
}

let proxyProcess = null;

function getProxyPath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'audio-translator-proxy', 'index.js');
  }
  return path.join(__dirname, '..', 'audio-translator-proxy', 'index.js');
}

function startProxy() {
  return new Promise((resolve, reject) => {
    const proxyPath = getProxyPath();
    console.log('[Main] Starting proxy:', proxyPath);

    if (!fs.existsSync(proxyPath)) {
      console.error('[Main] Proxy not found at:', proxyPath);
      reject(new Error(`代理服务文件不存在: ${proxyPath}`));
      return;
    }

    proxyProcess = spawn(process.execPath, [proxyPath], {
      cwd: path.dirname(proxyPath),
      env: { ...process.env, PORT: '3000' },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let started = false;

    proxyProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[Proxy]', output);
      if (!started && output.includes('Server running on port')) {
        started = true;
        resolve();
      }
    });

    proxyProcess.stderr.on('data', (data) => {
      console.error('[Proxy stderr]', data.toString());
    });

    proxyProcess.on('error', (err) => {
      console.error('[Main] Failed to start proxy:', err);
      if (!started) {
        reject(err);
      }
    });

    proxyProcess.on('exit', (code) => {
      console.log('[Main] Proxy exited with code:', code);
      proxyProcess = null;
      if (!started) {
        reject(new Error(`代理进程异常退出，退出码: ${code}`));
      }
    });

    setTimeout(() => {
      if (!started) {
        reject(new Error('代理启动超时（10秒），请检查端口 3000 是否被占用'));
      }
    }, 10000);
  });
}

function stopProxy() {
  if (proxyProcess) {
    console.log('[Main] Stopping proxy...');
    proxyProcess.kill('SIGTERM');
    proxyProcess = null;
  }
}

function getToolPath(toolName) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'audio-tools', toolName);
  }
  return path.join(__dirname, 'scripts', toolName);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    icon: path.join(__dirname, 'icon.png')
  });

  mainWindow.loadFile('index.html');
  
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (floatingWindow) {
      floatingWindow.close();
    }
  });
}

function createFloatingWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  
  floatingWindow = new BrowserWindow({
    width: 920,
    height: 320,
    minWidth: 560,
    minHeight: 180,
    x: width - 940,
    y: height - 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    skipTaskbar: true
  });

  floatingWindow.loadFile('floating.html');
  
  floatingWindow.on('closed', () => {
    floatingWindow = null;
  });
}

app.whenReady().then(async () => {
  getAudioEnvironment().catch(e => console.error('Failed to capture initial audio environment:', e));
  try {
    await startProxy();
    console.log('[Main] Proxy started successfully');
  } catch (e) {
    console.error('[Main] Proxy start failed:', e.message);
    // Still create windows — the error will be surfaced when user tries to connect
  }
  createMainWindow();
  createFloatingWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  if (!app.isRestoringAudioOutput) {
    event.preventDefault();
    app.isRestoringAudioOutput = true;
    closeDoubaoWs();
    stopProxy();
    if (didSwitchOutput) {
      try {
        const result = await restoreOriginalOutputDevice();
        console.log('[Main] Restore output result:', result);
      } catch (e) {
        console.error('[Main] Failed to restore output:', e);
      }
    }
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
    createFloatingWindow();
  }
});

ipcMain.handle('load-config', async () => {
  return loadConfig();
});

ipcMain.handle('save-config', async (event, config) => {
  await saveConfig(config);
  return { ok: true };
});

ipcMain.handle('get-audio-environment', async () => {
  return getAudioEnvironment();
});

ipcMain.handle('restore-original-output', async () => {
  return restoreOriginalOutputDevice();
});

ipcMain.handle('open-audio-midi-setup', async () => {
  const result = await shell.openPath('/System/Applications/Utilities/Audio MIDI Setup.app');
  return { ok: !result, message: result || '' };
});

ipcMain.handle('open-sound-settings', async () => {
  await shell.openExternal('x-apple.systempreferences:com.apple.Sound-Settings.extension');
  return { ok: true };
});

ipcMain.handle('open-privacy-security', async () => {
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security');
  return { ok: true };
});

ipcMain.handle('get-tool-path', async (event, toolName) => {
  return getToolPath(toolName);
});

ipcMain.handle('install-blackhole', async () => {
  const pkgPath = getToolPath('blackhole-2ch.pkg');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`BlackHole 安装包不存在: ${pkgPath}`);
  }
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/open', [pkgPath], { detached: true, stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`安装器启动失败，退出码: ${code}`));
    });
  });
});

ipcMain.handle('create-multi-output', async (event, targetDevice) => {
  const helperPath = getToolPath('create-aggregate-device');
  if (!fs.existsSync(helperPath)) {
    throw new Error(`多输出设备创建工具不存在: ${helperPath}`);
  }

  try {
    const args = targetDevice ? [targetDevice] : [];
    const stdout = await runCommand(helperPath, args);
    const parts = stdout.split(':');
    // Format: OK:deviceID:status:name  or  ERROR:message
    if (parts[0] === 'OK') {
      return { ok: true, deviceId: parseInt(parts[1], 10), status: parts[2], deviceName: parts[3] || '' };
    }
    throw new Error(stdout.replace('ERROR:', '').trim());
  } catch (e) {
    throw new Error(`创建多输出设备失败: ${e.message}`);
  }
});

ipcMain.handle('list-output-devices', async () => {
  const saPath = getToolPath('SwitchAudioSource');
  if (!fs.existsSync(saPath)) {
    return { ok: false, devices: [], message: 'SwitchAudioSource not found' };
  }

  try {
    const stdout = await runCommand(saPath, ['-a', '-t', 'output']);
    const devices = stdout.split('\n')
      .map(s => s.trim())
      .filter(name => {
        // Exclude BlackHole (virtual), aggregate/multi-output devices
        if (!name) return false;
        const lower = name.toLowerCase();
        if (lower.includes('blackhole')) return false;
        if (lower.includes('aggregate')) return false;
        if (lower.includes('multi')) return false;
        if (lower.includes('多输出')) return false;
        if (lower.includes('realtime translator')) return false;
        return true;
      });
    return { ok: true, devices };
  } catch (e) {
    return { ok: false, devices: [], message: e.message };
  }
});

ipcMain.handle('switch-output', async (event, deviceName) => {
  const saPath = getToolPath('SwitchAudioSource');
  if (!fs.existsSync(saPath)) {
    throw new Error(`SwitchAudioSource 不存在: ${saPath}`);
  }

  try {
    const stdout = await runCommand(saPath, ['-a']);
    const devices = stdout.split('\n').map(s => s.trim()).filter(Boolean);

    if (devices.includes(deviceName)) {
      await runCommand(saPath, ['-t', 'output', '-s', deviceName]);
      didSwitchOutput = true;
      return { ok: true, switched: true, deviceName };
    }

    // Try partial match
    const match = devices.find(d => d.toLowerCase().includes(deviceName.toLowerCase()));
    if (match) {
      await runCommand(saPath, ['-t', 'output', '-s', match]);
      didSwitchOutput = true;
      return { ok: true, switched: true, deviceName: match };
    }

    throw new Error(`未找到输出设备: ${deviceName}`);
  } catch (e) {
    throw new Error(`切换输出设备失败: ${e.message}`);
  }
});

ipcMain.handle('show-floating', () => {
  if (floatingWindow) {
    floatingWindow.show();
  }
});

ipcMain.handle('hide-floating', () => {
  if (floatingWindow) {
    floatingWindow.hide();
  }
});

ipcMain.handle('send-subtitle', (event, subtitle) => {
  if (floatingWindow) {
    floatingWindow.webContents.send('update-subtitle', subtitle);
  }
});

ipcMain.handle('get-sources', async () => {
  return await desktopCapturer.getSources({
    types: ['screen', 'window']
  });
});

ipcMain.handle('doubao-connect', async (event, config) => {
  closeDoubaoWs();

  if (!config || !config.appKey) {
    throw new Error('Missing API Key');
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const wsUrlWithAuth = `${DOUBAO_WS_URL}?api_key=${encodeURIComponent(config.appKey)}&resource_id=${encodeURIComponent(config.resourceId || 'volc.service_type.10053')}`;

    console.log('[Main] Connecting to proxy with config:', {
      apiKey: maskSecret(config.appKey),
      resourceId: config.resourceId || 'volc.service_type.10053'
    });
    doubaoWs = new WebSocket(wsUrlWithAuth);

    doubaoWs.on('open', () => {
      settled = true;
      doubaoPingTimer = setInterval(() => {
        if (doubaoWs && doubaoWs.readyState === WebSocket.OPEN) {
          try {
            doubaoWs.ping();
          } catch (e) {
            console.error('Failed to ping proxy WebSocket:', e);
          }
        }
      }, 20000);
      if (mainWindow) {
        mainWindow.webContents.send('doubao-log', '主进程 WebSocket 已连接');
      }
      resolve({ ok: true });
    });

    doubaoWs.on('message', (data) => {
      if (mainWindow) {
        mainWindow.webContents.send('doubao-message', data.toString());
      }
    });

    doubaoWs.on('error', (error) => {
      const technicalMessage = error && error.message ? error.message : String(error);
      const userMessage = friendlyError(technicalMessage);
      console.error('[Main] Doubao WebSocket error:', technicalMessage);
      if (mainWindow) {
        mainWindow.webContents.send('doubao-error', userMessage);
      }
      if (!settled) {
        settled = true;
        reject(new Error(userMessage));
      }
    });

    doubaoWs.on('close', (code, reasonBuffer) => {
      clearDoubaoPingTimer();
      const reason = reasonBuffer ? reasonBuffer.toString() : '';
      if (mainWindow) {
        mainWindow.webContents.send('doubao-close', { code, reason });
      }
      doubaoWs = null;
      if (!settled) {
        settled = true;
        reject(new Error(friendlyError(`WebSocket closed before open: ${code} ${reason}`)));
      }
    });
  });
});

ipcMain.handle('doubao-send', (event, message) => {
  if (!doubaoWs || doubaoWs.readyState !== WebSocket.OPEN) {
    throw new Error('翻译连接已断开，请重新点击开始翻译');
  }
  doubaoWs.send(typeof message === 'string' ? message : JSON.stringify(message));
});

ipcMain.handle('doubao-disconnect', () => {
  closeDoubaoWs();
});

ipcMain.handle('is-onboarding-complete', async () => {
  try {
    const config = await loadConfig();
    return !!config.onboardingCompleted;
  } catch (e) {
    return false;
  }
});

ipcMain.handle('complete-onboarding', async () => {
  try {
    const config = await loadConfig();
    config.onboardingCompleted = true;
    await saveConfig(config);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e.message };
  }
});
