// 音频格式转换工具
// 将 WebM/Opus 转换为 WAV/PCM (16kHz, 16bit, 单声道)

class AudioConverter {
  constructor() {
    this.audioContext = null;
  }

  // 初始化 AudioContext
  initAudioContext() {
    if (!this.audioContext) {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000
      });
    }
    return this.audioContext;
  }

  // 将 Blob 转换为 ArrayBuffer
  async blobToArrayBuffer(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsArrayBuffer(blob);
    });
  }

  // 将音频 Blob 转换为 WAV 格式
  async convertToWav(audioBlob) {
    try {
      const arrayBuffer = await this.blobToArrayBuffer(audioBlob);
      const audioContext = this.initAudioContext();

      // 解码音频数据
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      // 转换为 16kHz, 16bit, 单声道
      const targetSampleRate = 16000;
      const numberOfChannels = 1;
      const duration = audioBuffer.duration;
      const targetLength = Math.floor(duration * targetSampleRate);

      // 创建离线上下文进行重采样
      const offlineContext = new OfflineAudioContext(
        numberOfChannels,
        targetLength,
        targetSampleRate
      );

      // 创建音频源
      const source = offlineContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(offlineContext.destination);
      source.start(0);

      // 渲染音频
      const renderedBuffer = await offlineContext.startRendering();

      // 转换为 WAV 格式
      const wavBuffer = this.audioBufferToWav(renderedBuffer);

      return wavBuffer;
    } catch (error) {
      console.error('[AudioConverter] Convert to WAV error:', error);
      throw error;
    }
  }

  // 将 AudioBuffer 转换为 WAV 格式的 ArrayBuffer
  audioBufferToWav(audioBuffer) {
    const numberOfChannels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const format = 1; // PCM
    const bitDepth = 16;

    const bytesPerSample = bitDepth / 8;
    const blockAlign = numberOfChannels * bytesPerSample;

    const dataLength = audioBuffer.length * numberOfChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);

    // 写入 WAV 头部
    // "RIFF" chunk descriptor
    this.writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    this.writeString(view, 8, 'WAVE');

    // "fmt " sub-chunk
    this.writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true); // Subchunk1Size
    view.setUint16(20, format, true); // AudioFormat
    view.setUint16(22, numberOfChannels, true); // NumChannels
    view.setUint32(24, sampleRate, true); // SampleRate
    view.setUint32(28, sampleRate * blockAlign, true); // ByteRate
    view.setUint16(32, blockAlign, true); // BlockAlign
    view.setUint16(34, bitDepth, true); // BitsPerSample

    // "data" sub-chunk
    this.writeString(view, 36, 'data');
    view.setUint32(40, dataLength, true);

    // 写入音频数据
    const offset = 44;
    const channelData = audioBuffer.getChannelData(0); // 单声道

    for (let i = 0; i < audioBuffer.length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
      view.setInt16(offset + i * 2, intSample, true);
    }

    return buffer;
  }

  // 辅助函数：写入字符串到 DataView
  writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  // 将 ArrayBuffer 转换为 Uint8Array (用于 protobuf)
  arrayBufferToUint8Array(arrayBuffer) {
    return new Uint8Array(arrayBuffer);
  }

  // 将音频 Blob 转换为适合豆包同传的格式
  async convertForDoubaoAST(audioBlob) {
    try {
      // 转换为 WAV
      const wavBuffer = await this.convertToWav(audioBlob);

      // 提取 PCM 数据 (跳过 WAV 头部 44 字节)
      const pcmData = new Uint8Array(wavBuffer, 44);

      return pcmData;
    } catch (error) {
      console.error('[AudioConverter] Convert for Doubao AST error:', error);
      throw error;
    }
  }

  // 关闭 AudioContext
  close() {
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

// 导出
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AudioConverter;
}
