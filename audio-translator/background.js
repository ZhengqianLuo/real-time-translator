// 后台服务脚本 - 管理音频捕获和 AI 翻译

// 导入豆包同传客户端和音频转换器
importScripts(
  'lib/doubao-ast-client.js',
  'lib/audio-converter.js'
);

// 全局状态
let captureSessions = new Map(); // tabId -> session info
let audioStreams = new Map(); // tabId -> MediaStream
let doubaoClients = new Map(); // tabId -> DoubaoASTClient
let audioConverters = new Map(); // tabId -> AudioConverter
let offscreenDocumentPath = null;

// 默认配置
const defaultSettings = {
  apiKey: '',
  appKey: '', // 豆包同传 App Key
  resourceId: 'volc.service_type.10053', // 豆包同传 Resource ID
  provider: 'openai',
  sourceLanguage: 'id',
  targetLanguage: 'zh',
  subtitleStyle: {
    opacity: 0.75,
    bgColor: 'rgba(0, 0, 0, 0.75)',
    textColor: '#FFFFFF',
    fontSize: 14,
    maxLines: 5,
    autoScroll: true
  },
  windowState: {
    pinned: false,
    position: { x: null, y: null },
    size: { width: 400, height: 150 },
    visible: true
  }
};

// 安装时初始化
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ settings: defaultSettings });
  console.log('[Audio Translator] Extension installed');
});

// 启动时检查并清理离屏文档
chrome.runtime.onStartup.addListener(async () => {
  offscreenDocumentPath = null;
  console.log('[Audio Translator] Extension started');
});

// 监听来自 popup 和 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'START_CAPTURE':
      handleStartCapture(payload, sender, sendResponse);
      return true;

    case 'STOP_CAPTURE':
      handleStopCapture(payload, sender, sendResponse);
      return true;

    case 'GET_CAPTURE_STATUS':
      handleGetStatus(sender, sendResponse);
      return true;

    case 'GET_SETTINGS':
      handleGetSettings(sendResponse);
      return true;

    case 'SAVE_SETTINGS':
      handleSaveSettings(payload, sendResponse);
      return true;

    case 'CLEAR_SUBTITLES':
      handleClearSubtitles(sender, sendResponse);
      return true;

    case 'AUDIO_CHUNK_READY':
      handleAudioChunkReady(payload);
      return true;
  }
});

// 监听快捷键命令
chrome.commands.onCommand.addListener((command) => {
  switch (command) {
    case 'toggle-translation':
      toggleTranslation();
      break;
    case 'toggle-subtitle':
      toggleSubtitle();
      break;
  }
});

// 监听标签页关闭，清理资源
chrome.tabs.onRemoved.addListener((tabId) => {
  if (captureSessions.has(tabId)) {
    stopCapture(tabId);
  }
});

// 创建离屏文档
async function createOffscreenDocument() {
  if (offscreenDocumentPath) {
    console.log('[Audio Translator] Offscreen document already exists');
    return;
  }

  console.log('[Audio Translator] Creating offscreen document...');
  try {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Capture audio from the current tab for translation'
    });

    offscreenDocumentPath = 'offscreen.html';
    console.log('[Audio Translator] Offscreen document created successfully');
  } catch (error) {
    // 如果文档已存在，忽略错误
    if (error.message && error.message.includes('Only a single offscreen document may be created')) {
      console.log('[Audio Translator] Offscreen document already exists, reusing');
      offscreenDocumentPath = 'offscreen.html';
      return;
    }
    console.error('[Audio Translator] Failed to create offscreen document:', error);
    throw error;
  }
}

// 关闭离屏文档
async function closeOffscreenDocument() {
  if (!offscreenDocumentPath) {
    return;
  }

  await chrome.offscreen.closeDocument();
  offscreenDocumentPath = null;
  console.log('[Audio Translator] Offscreen document closed');
}

// 开始音频捕获
async function handleStartCapture(payload, sender, sendResponse) {
  console.log('[Audio Translator] Start capture called', payload);
  try {
    const tabId = payload?.tabId || sender.tab?.id;
    console.log('[Audio Translator] Tab ID:', tabId);

    if (!tabId) {
      sendResponse({ success: false, error: '无法获取标签页 ID' });
      return;
    }

    // 检查是否已在捕获中
    if (captureSessions.has(tabId)) {
      sendResponse({ success: true, message: '已在捕获中' });
      return;
    }

    // 获取设置
    const { settings } = await chrome.storage.local.get('settings');
    console.log('[Audio Translator] Settings:', { provider: settings.provider, hasAppKey: !!settings.appKey });

    // 检查 API Key
    if (settings.provider === 'doubao-ast') {
      if (!settings.appKey) {
        sendResponse({ success: false, error: '请先配置豆包同传 App Key' });
        return;
      }
    } else {
      if (!settings.apiKey) {
        sendResponse({ success: false, error: '请先配置 API Key' });
        return;
      }
    }

    // 创建离屏文档
    console.log('[Audio Translator] Creating offscreen document...');
    await createOffscreenDocument();
    console.log('[Audio Translator] Offscreen document ready');

    // 创建会话
    const sessionId = generateId();
    captureSessions.set(tabId, {
      sessionId,
      tabId,
      startedAt: Date.now(),
      status: 'active',
      settings
    });

    // 如果是豆包同传模式，初始化 WebSocket 连接
    if (settings.provider === 'doubao-ast') {
      console.log('[Audio Translator] Initializing Doubao AST client...');
      await initDoubaoASTClient(tabId, settings);
      console.log('[Audio Translator] Doubao AST client initialized');
    }

    // 通知离屏文档开始捕获音频
    console.log('[Audio Translator] Starting audio capture in offscreen document...');
    const response = await chrome.runtime.sendMessage({
      type: 'START_AUDIO_CAPTURE',
      payload: { tabId, settings }
    });

    if (!response.success) {
      throw new Error(response.error || '启动音频捕获失败');
    }

    console.log('[Audio Translator] Audio capture started');

    // 通知 content script 显示字幕窗
    chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_SUBTITLE_WINDOW',
      payload: { sessionId }
    });

    sendResponse({ success: true, sessionId });

  } catch (error) {
    console.error('[Audio Translator] Start capture error:', error);
    console.error('[Audio Translator] Error stack:', error.stack);
    sendResponse({ success: false, error: error.message || '未知错误' });
  }
}

// 处理音频块就绪
async function handleAudioChunkReady(payload) {
  const { tabId, audioData, settings } = payload;
  console.log('[Audio Translator] Audio chunk ready for tab', tabId);

  const session = captureSessions.get(tabId);
  if (!session || session.status !== 'active') {
    console.log('[Audio Translator] Session not active, ignoring audio chunk');
    return;
  }

  try {
    // 将 Base64 转换回 Blob
    const binaryString = atob(audioData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const audioBlob = new Blob([bytes], { type: 'audio/webm' });

    // 检查音频大小
    if (audioBlob.size < 500) {
      console.log('[Audio Translator] Audio chunk too small, skipping');
      return;
    }

    // 豆包同传模式
    if (settings.provider === 'doubao-ast') {
      await processAudioWithDoubaoAST(tabId, audioBlob);
    } else {
      // 其他模式
      await processAudioChunk(tabId, audioBlob, settings);
    }

  } catch (error) {
    console.error('[Audio Translator] Process audio chunk error:', error);
  }
}

// 初始化豆包同传客户端
async function initDoubaoASTClient(tabId, settings) {
  console.log('[Audio Translator] initDoubaoASTClient called with tabId:', tabId);
  try {
    // 创建音频转换器
    console.log('[Audio Translator] Creating AudioConverter...');
    const audioConverter = new AudioConverter();
    audioConverters.set(tabId, audioConverter);
    console.log('[Audio Translator] AudioConverter created');

    // 创建豆包同传客户端
    console.log('[Audio Translator] Creating DoubaoASTClient...');
    const client = new DoubaoASTClient({
      appKey: settings.appKey,
      resourceId: settings.resourceId || 'volc.service_type.10053',
      mode: 's2t',
      sourceLanguage: settings.sourceLanguage,
      targetLanguage: settings.targetLanguage,
      onSubtitle: (subtitle) => {
        handleDoubaoSubtitle(tabId, subtitle);
      },
      onError: (error) => {
        console.error('[Audio Translator] Doubao AST error:', error);
        chrome.tabs.sendMessage(tabId, {
          type: 'UPDATE_STATUS',
          payload: { status: 'error', message: error }
        }).catch(() => {});
      },
      onConnect: () => {
        console.log('[Audio Translator] Doubao AST connected');
        chrome.tabs.sendMessage(tabId, {
          type: 'UPDATE_STATUS',
          payload: { status: 'connected' }
        }).catch(() => {});
      },
      onDisconnect: () => {
        console.log('[Audio Translator] Doubao AST disconnected');
      }
    });

    doubaoClients.set(tabId, client);
    console.log('[Audio Translator] DoubaoASTClient created, connecting...');

    // 连接 WebSocket
    await client.connect();
    console.log('[Audio Translator] Doubao AST client initialized for tab', tabId);

  } catch (error) {
    console.error('[Audio Translator] Init Doubao AST client error:', error);
    throw error;
  }
}

// 处理豆包同传返回的字幕
function handleDoubaoSubtitle(tabId, subtitle) {
  const session = captureSessions.get(tabId);
  if (!session || session.status !== 'active') return;

  chrome.tabs.sendMessage(tabId, {
    type: 'UPDATE_SUBTITLE',
    payload: {
      id: generateId(),
      originalText: subtitle.type === 'source' ? subtitle.text : '',
      translatedText: subtitle.type === 'translation' ? subtitle.text : '',
      timestamp: Date.now(),
      isFinal: subtitle.isFinal,
      startTime: subtitle.startTime,
      endTime: subtitle.endTime
    }
  }).catch(() => {});
}

// 停止音频捕获
async function handleStopCapture(payload, sender, sendResponse) {
  console.log('[Audio Translator] Stop capture called');
  try {
    const tabId = payload?.tabId || sender.tab?.id;

    if (tabId && captureSessions.has(tabId)) {
      await stopCapture(tabId);
    }

    sendResponse({ success: true });
  } catch (error) {
    console.error('[Audio Translator] Stop capture error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 获取捕获状态
function handleGetStatus(sender, sendResponse) {
  const tabId = sender.tab?.id;
  const isCapturing = tabId ? captureSessions.has(tabId) : false;
  sendResponse({ isCapturing });
}

// 获取设置
async function handleGetSettings(sendResponse) {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const safeSettings = { ...settings };
    delete safeSettings.apiKey;
    delete safeSettings.appKey;
    sendResponse({ success: true, settings: safeSettings });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// 保存设置
async function handleSaveSettings(payload, sendResponse) {
  try {
    const { settings } = await chrome.storage.local.get('settings');
    const newSettings = { ...settings, ...payload };
    await chrome.storage.local.set({ settings: newSettings });
    sendResponse({ success: true });
  } catch (error) {
    sendResponse({ success: false, error: error.message });
  }
}

// 清空字幕
function handleClearSubtitles(sender, sendResponse) {
  const tabId = sender.tab?.id;
  if (tabId) {
    chrome.tabs.sendMessage(tabId, {
      type: 'CLEAR_SUBTITLES'
    });
  }
  sendResponse({ success: true });
}

// 停止捕获并清理资源
async function stopCapture(tabId) {
  console.log('[Audio Translator] Stopping capture for tab', tabId);
  const session = captureSessions.get(tabId);
  if (session) {
    session.status = 'stopped';
    session.endedAt = Date.now();
  }

  // 通知离屏文档停止捕获
  try {
    await chrome.runtime.sendMessage({
      type: 'STOP_AUDIO_CAPTURE'
    });
  } catch (e) {
    console.log('[Audio Translator] Stop offscreen capture error:', e);
  }

  // 关闭豆包同传客户端
  const doubaoClient = doubaoClients.get(tabId);
  if (doubaoClient) {
    doubaoClient.close();
    doubaoClients.delete(tabId);
  }

  // 关闭音频转换器
  const audioConverter = audioConverters.get(tabId);
  if (audioConverter) {
    audioConverter.close();
    audioConverters.delete(tabId);
  }

  captureSessions.delete(tabId);

  // 关闭离屏文档
  await closeOffscreenDocument();

  // 通知 content script 隐藏字幕窗
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'HIDE_SUBTITLE_WINDOW'
    });
  } catch (e) {
    // 标签页可能已关闭
  }

  console.log(`[Audio Translator] Capture stopped for tab ${tabId}`);
}

// 使用豆包同传处理音频
async function processAudioWithDoubaoAST(tabId, audioBlob) {
  try {
    const client = doubaoClients.get(tabId);
    const audioConverter = audioConverters.get(tabId);

    if (!client || !audioConverter) {
      console.warn('[Audio Translator] Doubao AST client or converter not found');
      return;
    }

    if (!client.isSessionStarted) {
      console.warn('[Audio Translator] Doubao AST session not started yet');
      return;
    }

    // 转换音频格式
    const pcmData = await audioConverter.convertForDoubaoAST(audioBlob);

    // 将 Uint8Array 转换为 Base64
    const base64Data = arrayBufferToBase64(pcmData.buffer);

    // 发送音频数据到 WebSocket
    client.sendAudioData(base64Data);

  } catch (error) {
    console.error('[Audio Translator] Process audio with Doubao AST error:', error);
  }
}

// 处理音频块 - 发送到 AI 进行翻译（非豆包同传模式）
async function processAudioChunk(tabId, audioBlob, settings) {
  try {
    // 通知 content script 显示处理中状态
    chrome.tabs.sendMessage(tabId, {
      type: 'UPDATE_STATUS',
      payload: { status: 'translating' }
    }).catch(() => {});

    // 调用 AI 服务进行翻译
    const result = await translateAudio(audioBlob, settings);

    if (result && result.translatedText) {
      chrome.tabs.sendMessage(tabId, {
        type: 'UPDATE_SUBTITLE',
        payload: {
          id: generateId(),
          originalText: result.originalText || '',
          translatedText: result.translatedText,
          timestamp: Date.now(),
          isFinal: true
        }
      }).catch(() => {});
    }

  } catch (error) {
    console.error('[Audio Translator] Process audio error:', error);
    chrome.tabs.sendMessage(tabId, {
      type: 'UPDATE_STATUS',
      payload: { status: 'error', message: error.message }
    }).catch(() => {});
  }
}

// AI 翻译音频
async function translateAudio(audioBlob, settings) {
  const { apiKey, provider, sourceLanguage, targetLanguage } = settings;

  if (!apiKey) {
    throw new Error('API Key 未配置');
  }

  switch (provider) {
    case 'openai':
      return await translateWithOpenAI(audioBlob, apiKey, sourceLanguage, targetLanguage);
    case 'doubao':
      return await translateWithDoubao(audioBlob, settings, sourceLanguage, targetLanguage);
    case 'claude':
      return await translateWithClaude(audioBlob, apiKey, sourceLanguage, targetLanguage);
    case 'gemini':
      return await translateWithGemini(audioBlob, apiKey, sourceLanguage, targetLanguage);
    default:
      throw new Error(`不支持的翻译提供商: ${provider}`);
  }
}

// OpenAI 翻译
async function translateWithOpenAI(audioBlob, apiKey, sourceLang, targetLang) {
  const formData = new FormData();
  formData.append('file', audioBlob, 'audio.webm');
  formData.append('model', 'whisper-1');
  formData.append('language', sourceLang);

  const transcribeResponse = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!transcribeResponse.ok) {
    const error = await transcribeResponse.json();
    throw new Error(`Whisper API 错误: ${error.error?.message || '未知错误'}`);
  }

  const transcribeData = await transcribeResponse.json();
  const originalText = transcribeData.text;

  if (!originalText || originalText.trim().length === 0) {
    return null;
  }

  const translateResponse = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `你是一个专业的翻译助手。请将${sourceLang === 'id' ? '印尼语' : sourceLang}翻译成${targetLang === 'zh' ? '中文' : targetLang}，保持口语化风格，只返回翻译结果。`
        },
        {
          role: 'user',
          content: originalText
        }
      ],
      temperature: 0.3,
      max_tokens: 500
    })
  });

  if (!translateResponse.ok) {
    const error = await translateResponse.json();
    throw new Error(`GPT API 错误: ${error.error?.message || '未知错误'}`);
  }

  const translateData = await translateResponse.json();
  const translatedText = translateData.choices[0]?.message?.content || '';

  return {
    originalText,
    translatedText: translatedText.trim()
  };
}

// Claude 翻译（预留）
async function translateWithClaude(audioBlob, apiKey, sourceLang, targetLang) {
  throw new Error('Claude 翻译需要配合语音识别服务，请使用 OpenAI 或配置外部语音识别');
}

// Gemini 翻译（预留）
async function translateWithGemini(audioBlob, apiKey, sourceLang, targetLang) {
  throw new Error('Gemini 翻译接口待实现');
}

// 豆包大模型翻译（HTTP 模式）
async function translateWithDoubao(audioBlob, settings, sourceLang, targetLang) {
  const { apiKey, doubaoEndpoint, doubaoModel } = settings;

  if (!doubaoModel) {
    throw new Error('豆包模型 ID 未配置');
  }

  const endpoint = doubaoEndpoint || 'https://ark.cn-beijing.volces.com/api/v3';

  try {
    const base64Audio = await blobToBase64(audioBlob);

    const requestBody = {
      model: doubaoModel,
      messages: [
        {
          role: 'system',
          content: `你是一个专业的音频翻译助手。请将${sourceLang === 'id' ? '印尼语' : sourceLang}音频内容翻译成${targetLang === 'zh' ? '中文' : targetLang}，保持口语化风格。只返回翻译结果。`
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请转录并翻译这段音频内容：'
            },
            {
              type: 'audio_url',
              audio_url: {
                url: `data:audio/webm;base64,${base64Audio}`
              }
            }
          ]
        }
      ],
      temperature: 0.3,
      max_tokens: 1000
    };

    const response = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(`豆包 API 错误: ${error.error?.message || error.message || '未知错误'}`);
    }

    const data = await response.json();
    const result = data.choices[0]?.message?.content || '';

    const lines = result.split('\n').filter(line => line.trim());
    let originalText = '';
    let translatedText = result;

    for (const line of lines) {
      if (line.includes('原文') || line.includes('Source')) {
        originalText = line.replace(/.*[:：]\s*/, '').trim();
      } else if (line.includes('译文') || line.includes('Translation') || line.includes('翻译')) {
        translatedText = line.replace(/.*[:：]\s*/, '').trim();
      }
    }

    return {
      originalText,
      translatedText: translatedText || result
    };

  } catch (error) {
    console.error('[Audio Translator] Doubao error:', error);
    throw error;
  }
}

// Blob 转 Base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64 = reader.result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ArrayBuffer 转 Base64
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// 切换翻译状态
async function toggleTranslation() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    const isCapturing = captureSessions.has(tab.id);

    if (isCapturing) {
      await stopCapture(tab.id);
    } else {
      chrome.runtime.sendMessage({
        type: 'START_CAPTURE',
        payload: { tabId: tab.id }
      });
    }
  } catch (error) {
    console.error('[Audio Translator] Toggle error:', error);
  }
}

// 切换字幕显示
async function toggleSubtitle() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;

    chrome.tabs.sendMessage(tab.id, {
      type: 'TOGGLE_SUBTITLE_VISIBILITY'
    }).catch(() => {});
  } catch (error) {
    console.error('[Audio Translator] Toggle subtitle error:', error);
  }
}

// 生成唯一 ID
function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}
