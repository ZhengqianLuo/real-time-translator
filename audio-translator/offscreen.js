// 离屏文档 - 用于音频捕获和处理
// 因为 tabCapture API 不能在 Service Worker 中使用

let mediaRecorder = null;
let audioChunks = [];
let recordingInterval = null;

// 监听来自 background 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const { type, payload } = message;

  switch (type) {
    case 'START_AUDIO_CAPTURE':
      handleStartCapture(payload, sendResponse);
      return true;

    case 'STOP_AUDIO_CAPTURE':
      handleStopCapture(sendResponse);
      return true;
  }
});

// 开始音频捕获
async function handleStartCapture(payload, sendResponse) {
  try {
    const { tabId, settings } = payload;

    // 捕获音频流
    const stream = await chrome.tabCapture.capture({
      audio: true,
      video: false
    });

    if (!stream) {
      sendResponse({ success: false, error: '无法捕获音频，请确保页面正在播放音频' });
      return;
    }

    // 创建 MediaRecorder
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: 'audio/webm;codecs=opus'
    });

    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };

    mediaRecorder.onstop = async () => {
      if (audioChunks.length > 0) {
        const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });

        // 将音频数据发送给 background
        // 使用 ArrayBuffer 传输
        const arrayBuffer = await audioBlob.arrayBuffer();
        const base64Data = arrayBufferToBase64(arrayBuffer);

        chrome.runtime.sendMessage({
          type: 'AUDIO_CHUNK_READY',
          payload: {
            tabId: tabId,
            audioData: base64Data,
            settings: settings
          }
        });

        audioChunks = [];
      }

      // 如果还在录制中，重新开始
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        startNewRecordingCycle(tabId, settings);
      }
    };

    // 开始录制
    const recordInterval = settings.provider === 'doubao-ast' ? 500 : 5000;
    mediaRecorder.start(recordInterval);

    // 定时停止并重新开始
    recordingInterval = setTimeout(() => {
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
    }, recordInterval);

    sendResponse({ success: true });

  } catch (error) {
    console.error('[Offscreen] Start capture error:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 开始新的录制周期
function startNewRecordingCycle(tabId, settings) {
  if (!mediaRecorder) return;

  const recordInterval = settings.provider === 'doubao-ast' ? 500 : 5000;

  mediaRecorder.start(recordInterval);

  recordingInterval = setTimeout(() => {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  }, recordInterval);
}

// 停止音频捕获
async function handleStopCapture(sendResponse) {
  try {
    if (recordingInterval) {
      clearTimeout(recordingInterval);
      recordingInterval = null;
    }

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }

    mediaRecorder = null;
    audioChunks = [];

    sendResponse({ success: true });
  } catch (error) {
    console.error('[Offscreen] Stop capture error:', error);
    sendResponse({ success: false, error: error.message });
  }
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
