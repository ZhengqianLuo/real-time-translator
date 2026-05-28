const { ipcRenderer } = require('electron');

console.log('=== renderer.js 已加载 ===');

let config = {};
let audioStream = null;
let mediaRecorder = null;
let audioContext = null;
let ws = null;
let isTranslating = false;

const appKeyInput = document.getElementById('appKey');
const resourceIdInput = document.getElementById('resourceId');
const sourceLanguageSelect = document.getElementById('sourceLanguage');
const targetLanguageSelect = document.getElementById('targetLanguage');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const saveBtn = document.getElementById('saveBtn');
const toggleFloatBtn = document.getElementById('toggleFloatBtn');
const statusDiv = document.getElementById('status');

let floatVisible = true;

async function loadConfig() {
  try {
    console.log('正在加载配置...');
    config = await ipcRenderer.invoke('load-config');
    console.log('配置已加载:', config);
    appKeyInput.value = config.appKey || '';
    resourceIdInput.value = config.resourceId || 'volc.service_type.10053';
    sourceLanguageSelect.value = config.sourceLanguage || 'id';
    targetLanguageSelect.value = config.targetLanguage || 'zh';
  } catch (e) {
    console.log('加载配置失败，使用默认值', e);
  }
}

async function saveConfig() {
  try {
    config = {
      appKey: appKeyInput.value,
      resourceId: resourceIdInput.value,
      sourceLanguage: sourceLanguageSelect.value,
      targetLanguage: targetLanguageSelect.value
    };
    await ipcRenderer.invoke('save-config', config);
    alert('配置已保存！');
  } catch (e) {
    console.error('保存配置失败', e);
    alert('保存配置失败: ' + e.message);
  }
}

function updateStatus(message, type = 'idle') {
  console.log('状态更新:', message, type);
  statusDiv.textContent = message;
  statusDiv.className = `status status-${type}`;
}

function generateSessionId() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

async function startTranslation() {
  console.log('=== 开始翻译 ===');
  
  if (!appKeyInput.value) {
    console.log('没有 API Key');
    alert('请先配置 API Key！');
    return;
  }

  try {
    updateStatus('正在启动...', 'translating');
    startBtn.disabled = true;
    
    // 先从输入框获取最新配置
    config = {
      appKey: appKeyInput.value,
      resourceId: resourceIdInput.value,
      sourceLanguage: sourceLanguageSelect.value,
      targetLanguage: targetLanguageSelect.value
    };
    
    console.log('配置:', {
      appKey: config.appKey.substring(0, 10) + '...',
      resourceId: config.resourceId,
      sourceLanguage: config.sourceLanguage,
      targetLanguage: config.targetLanguage
    });
    
    // 获取音频输入 - 先用麦克风测试
    console.log('正在请求音频权限...');
    audioStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });
    
    console.log('音频流获取成功');
    
    // 创建音频上下文
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    const sourceNode = audioContext.createMediaStreamSource(audioStream);
    const destination = audioContext.createMediaStreamDestination();
    sourceNode.connect(destination);
    
    console.log('AudioContext 已创建');
    
    // 创建媒体录制器
    mediaRecorder = new MediaRecorder(audioStream, {
      mimeType: 'audio/webm;codecs=opus'
    });
    
    const sessionId = generateSessionId();
    console.log('会话 ID:', sessionId);
    
    // 构建 WebSocket URL - 使用 URL 参数方式
    const wsUrl = `wss://openspeech.bytedance.com/api/v4/ast/v2/translate?app_key=${encodeURIComponent(config.appKey)}&resource_id=${encodeURIComponent(config.resourceId)}`;
    
    console.log('WebSocket URL:', wsUrl);
    
    updateStatus('正在连接服务器...', 'translating');
    
    console.log('正在创建 WebSocket 连接...');
    ws = new WebSocket(wsUrl);
    
    ws.onopen = () => {
      console.log('WebSocket 已连接');
      updateStatus('连接成功，正在初始化...', 'translating');
      
      // 发送开始会话请求
      const startRequest = {
        request_meta: {
          session_id: sessionId
        },
        event: 100,
        user: {
          uid: 'desktop-' + Date.now(),
          did: 'desktop',
          platform: 'Electron Desktop',
          sdk_version: '1.0.0'
        },
        request: {
          mode: 's2t',
          speech_rate: 0,
          source_language: config.sourceLanguage,
          target_language: config.targetLanguage,
          corpus: {}
        },
        source_audio: {
          format: 'wav',
          codec: 'raw',
          rate: 16000,
          bits: 16,
          channel: 1
        }
      };
      
      console.log('发送开始会话请求');
      ws.send(JSON.stringify(startRequest));
      
      // 开始录音
      let audioChunks = [];
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunks.push(event.data);
          
          // 每 10 个 chunk 发送一次
          if (audioChunks.length >= 10) {
            const blob = new Blob(audioChunks, { type: 'audio/webm' });
            convertToWav(blob).then(wavData => {
              if (ws && ws.readyState === WebSocket.OPEN && isTranslating) {
                const audioRequest = {
                  event: 200,
                  source_audio: {
                    data: wavData
                  }
                };
                ws.send(JSON.stringify(audioRequest));
              }
            }).catch(e => console.error('转换音频失败', e));
            audioChunks = [];
          }
        }
      };
      
      console.log('启动录音...');
      mediaRecorder.start(100);
      isTranslating = true;
      updateStatus('正在翻译...', 'translating');
      stopBtn.disabled = false;
    };
    
    ws.onmessage = (event) => {
      console.log('收到 WebSocket 消息');
      try {
        const response = JSON.parse(event.data);
        console.log('消息内容:', response);
        
        let subtitleText = '';
        let sourceText = '';
        
        switch (response.event) {
          case 150:
            console.log('会话已开始');
            updateStatus('会话已开始', 'translating');
            break;
          case 651:
            sourceText = response.text || '';
            break;
          case 652:
            sourceText = response.text || '';
            break;
          case 654:
            subtitleText = response.text || '';
            console.log('翻译结果:', subtitleText);
            break;
          case 655:
            subtitleText = response.text || '';
            break;
          case 152:
            console.log('会话已结束');
            break;
          case 153:
            console.error('会话失败:', response.response_meta?.message);
            updateStatus('会话失败: ' + (response.response_meta?.message || '未知错误'), 'error');
            break;
        }
        
        if (subtitleText || sourceText) {
          ipcRenderer.invoke('send-subtitle', {
            source: sourceText,
            translation: subtitleText
          });
        }
      } catch (e) {
        console.error('解析消息失败', e, event.data);
      }
    };
    
    ws.onerror = (error) => {
      console.error('WebSocket 错误', error);
      updateStatus('连接错误', 'error');
      stopTranslation();
    };
    
    ws.onclose = (code, reason) => {
      console.log('WebSocket 已关闭', code, reason);
      if (isTranslating) {
        updateStatus('连接已断开', 'error');
        stopTranslation();
      }
    };
    
  } catch (error) {
    console.error('启动失败', error);
    updateStatus('启动失败: ' + error.message, 'error');
    startBtn.disabled = false;
    alert('启动失败: ' + error.message);
  }
}

async function convertToWav(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
  
  // 创建离线音频上下文，转换为 16kHz, 单声道
  const offlineContext = new OfflineAudioContext(
    1,
    audioBuffer.duration * 16000,
    16000
  );
  
  const source = offlineContext.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(offlineContext.destination);
  source.start();
  
  const renderedBuffer = await offlineContext.startRendering();
  const wavData = audioBufferToWav(renderedBuffer);
  
  return arrayBufferToBase64(wavData);
}

function audioBufferToWav(buffer) {
  const numChannels = 1;
  const sampleRate = 16000;
  const format = 1;
  const bitDepth = 16;
  
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  
  const data = buffer.getChannelData(0);
  const dataLength = data.length * blockAlign;
  const bufferLength = 44 + dataLength;
  
  const arrayBuffer = new ArrayBuffer(bufferLength);
  const view = new DataView(arrayBuffer);
  
  // RIFF 头
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  
  // fmt 块
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  
  // data 块
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);
  floatTo16BitPCM(view, 44, data);
  
  return arrayBuffer;
}

function writeString(view, offset, string) {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

function floatTo16BitPCM(output, offset, input) {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function stopTranslation() {
  console.log('=== 停止翻译 ===');
  isTranslating = false;
  
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    try {
      mediaRecorder.stop();
    } catch (e) {}
  }
  
  if (audioStream) {
    audioStream.getTracks().forEach(track => track.stop());
  }
  
  if (ws) {
    try {
      const finishRequest = { event: 102 };
      ws.send(JSON.stringify(finishRequest));
    } catch (e) {}
    ws.close();
    ws = null;
  }
  
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  
  startBtn.disabled = false;
  stopBtn.disabled = true;
  updateStatus('已停止', 'idle');
  
  ipcRenderer.invoke('send-subtitle', {
    source: '',
    translation: ''
  });
}

function toggleFloat() {
  floatVisible = !floatVisible;
  if (floatVisible) {
    ipcRenderer.invoke('show-floating');
    toggleFloatBtn.textContent = '👁️ 隐藏浮窗';
  } else {
    ipcRenderer.invoke('hide-floating');
    toggleFloatBtn.textContent = '👁️ 显示浮窗';
  }
}

console.log('正在绑定事件...');
startBtn.addEventListener('click', startTranslation);
stopBtn.addEventListener('click', stopTranslation);
saveBtn.addEventListener('click', saveConfig);
toggleFloatBtn.addEventListener('click', toggleFloat);
console.log('事件已绑定');

loadConfig();
console.log('=== 应用初始化完成 ===');
