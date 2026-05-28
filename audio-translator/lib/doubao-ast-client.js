// 豆包同传大模型 (AST) WebSocket 客户端
// 实现实时语音翻译功能

class DoubaoASTClient {
  constructor(config) {
    this.config = {
      appKey: config.appKey,
      resourceId: config.resourceId || 'volc.service_type.10053',
      mode: config.mode || 's2t', // s2t: 语音到文本, s2s: 语音到语音
      sourceLanguage: config.sourceLanguage || 'id',
      targetLanguage: config.targetLanguage || 'zh',
      onSubtitle: config.onSubtitle || (() => {}),
      onError: config.onError || (() => {}),
      onConnect: config.onConnect || (() => {}),
      onDisconnect: config.onDisconnect || (() => {})
    };
    
    this.ws = null;
    this.sessionId = this.generateSessionId();
    this.isConnected = false;
    this.isSessionStarted = false;
    
    // WebSocket URL - 连接本地代理
    this.wsUrl = 'ws://localhost:3000';
  }
  
  // 生成会话ID
  generateSessionId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }
  
  // 连接 WebSocket
  async connect() {
    try {
      return new Promise((resolve, reject) => {
        // 创建 WebSocket 连接 - 连接本地代理
        const wsUrlWithAuth = `${this.wsUrl}?app_key=${encodeURIComponent(this.config.appKey)}&resource_id=${encodeURIComponent(this.config.resourceId)}`;
        
        console.log('[DoubaoAST] Connecting to:', wsUrlWithAuth);
        this.ws = new WebSocket(wsUrlWithAuth);
        
        this.ws.binaryType = 'arraybuffer';
        
        this.ws.onopen = () => {
          console.log('[DoubaoAST] WebSocket connected');
          this.isConnected = true;
          this.sendStartSession();
        };
        
        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };
        
        this.ws.onerror = (error) => {
          console.error('[DoubaoAST] WebSocket error:', error);
          this.config.onError('WebSocket 连接错误');
          reject(error);
        };
        
        this.ws.onclose = () => {
          console.log('[DoubaoAST] WebSocket closed');
          this.isConnected = false;
          this.isSessionStarted = false;
          this.config.onDisconnect();
        };
        
        // 等待 SessionStarted 事件
        this._resolveConnect = resolve;
        this._rejectConnect = reject;
        
        // 连接超时
        setTimeout(() => {
          if (!this.isSessionStarted) {
            reject(new Error('连接超时'));
          }
        }, 10000);
      });
    } catch (error) {
      console.error('[DoubaoAST] Connect error:', error);
      throw error;
    }
  }
  
  // 发送开始会话请求
  sendStartSession() {
    // 构建 JSON 格式的请求（作为备用方案）
    const request = {
      request_meta: {
        session_id: this.sessionId
      },
      event: 100, // StartSession
      user: {
        uid: 'chrome-extension-' + Date.now(),
        did: 'chrome',
        platform: 'Chrome Extension',
        sdk_version: '1.0.0'
      },
      request: {
        mode: this.config.mode,
        speech_rate: 0,
        source_language: this.config.sourceLanguage,
        target_language: this.config.targetLanguage,
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
    
    // s2s 模式需要配置 targetAudio
    if (this.config.mode === 's2s') {
      request.target_audio = {
        format: 'pcm',
        rate: 24000
      };
    }
    
    this.sendRequest(request);
  }
  
  // 发送音频数据
  sendAudioData(base64Data) {
    if (!this.isSessionStarted) {
      console.warn('[DoubaoAST] Session not started yet');
      return;
    }
    
    const request = {
      event: 200, // TaskRequest
      source_audio: {
        data: base64Data // Base64 编码的音频数据
      }
    };
    
    this.sendRequest(request);
  }
  
  // 发送结束会话请求
  sendFinishSession() {
    const request = {
      event: 102 // FinishSession
    };
    
    this.sendRequest(request);
  }
  
  // 发送请求
  sendRequest(requestData) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[DoubaoAST] WebSocket not open');
      return;
    }
    
    try {
      // 发送 JSON 格式的消息
      const message = JSON.stringify(requestData);
      this.ws.send(message);
    } catch (error) {
      console.error('[DoubaoAST] Send request error:', error);
    }
  }
  
  // 处理接收到的消息
  handleMessage(data) {
    try {
      // 尝试解析为 JSON
      const response = JSON.parse(data);
      
      console.log('[DoubaoAST] Received event:', response.event, 'text:', response.text);
      
      switch (response.event) {
        case 150: // SessionStarted
          console.log('[DoubaoAST] Session started');
          this.isSessionStarted = true;
          this.config.onConnect();
          if (this._resolveConnect) {
            this._resolveConnect();
            this._resolveConnect = null;
          }
          break;
          
        case 651: // SourceSubtitleResponse - 原文
          if (response.text) {
            this.config.onSubtitle({
              type: 'source',
              text: response.text,
              startTime: response.start_time,
              endTime: response.end_time,
              isFinal: false
            });
          }
          break;
          
        case 652: // SourceSubtitleEnd - 原文结束
          if (response.text) {
            this.config.onSubtitle({
              type: 'source',
              text: response.text,
              startTime: response.start_time,
              endTime: response.end_time,
              isFinal: true
            });
          }
          break;
          
        case 654: // TranslationSubtitleResponse - 译文
          if (response.text) {
            this.config.onSubtitle({
              type: 'translation',
              text: response.text,
              startTime: response.start_time,
              endTime: response.end_time,
              isFinal: false
            });
          }
          break;
          
        case 655: // TranslationSubtitleEnd - 译文结束
          if (response.text) {
            this.config.onSubtitle({
              type: 'translation',
              text: response.text,
              startTime: response.start_time,
              endTime: response.end_time,
              isFinal: true
            });
          }
          break;
          
        case 152: // SessionFinished
          console.log('[DoubaoAST] Session finished');
          this.close();
          break;
          
        case 153: // SessionFailed
          console.error('[DoubaoAST] Session failed:', response.response_meta?.message);
          this.config.onError('会话失败: ' + (response.response_meta?.message || '未知错误'));
          this.close();
          break;
          
        case 154: // UsageResponse - 计费信息
          console.log('[DoubaoAST] Usage:', response.response_meta?.billing);
          break;
          
        case 250: // AudioMuted - 静音
          console.log('[DoubaoAST] Audio muted:', response.muted_duration_ms);
          break;
          
        default:
          console.log('[DoubaoAST] Unknown event:', response.event);
      }
    } catch (error) {
      console.error('[DoubaoAST] Handle message error:', error);
    }
  }
  
  // 关闭连接
  close() {
    if (this.ws) {
      if (this.isConnected) {
        this.sendFinishSession();
      }
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.isSessionStarted = false;
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DoubaoASTClient;
}
