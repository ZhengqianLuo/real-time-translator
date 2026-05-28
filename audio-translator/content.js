// 内容脚本 - 注入字幕悬浮窗 UI

(function() {
  'use strict';
  
  // 防止重复注入
  if (window.audioTranslatorInjected) {
    return;
  }
  window.audioTranslatorInjected = true;
  
  // 全局状态
  let subtitleWindow = null;
  let subtitleList = [];
  let isDragging = false;
  let dragOffset = { x: 0, y: 0 };
  let currentSettings = null;
  let isVisible = true;
  let isPinned = false;
  let isMinimized = false;
  
  // 初始化
  init();
  
  function init() {
    // 监听来自 background 的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const { type, payload } = message;
      
      switch (type) {
        case 'SHOW_SUBTITLE_WINDOW':
          showSubtitleWindow();
          sendResponse({ success: true });
          break;
          
        case 'HIDE_SUBTITLE_WINDOW':
          hideSubtitleWindow();
          sendResponse({ success: true });
          break;
          
        case 'RESTORE_SUBTITLE_WINDOW':
          if (payload?.sessionActive) {
            showSubtitleWindow();
          }
          sendResponse({ success: true });
          break;
          
        case 'TOGGLE_SUBTITLE_VISIBILITY':
          toggleVisibility();
          sendResponse({ success: true });
          break;
          
        case 'UPDATE_SUBTITLE':
          addSubtitle(payload);
          sendResponse({ success: true });
          break;
          
        case 'UPDATE_STATUS':
          updateStatus(payload);
          sendResponse({ success: true });
          break;
          
        case 'CLEAR_SUBTITLES':
          clearSubtitles();
          sendResponse({ success: true });
          break;
      }
      
      return true;
    });
    
    // 加载设置
    loadSettings();
  }
  
  // 加载设置
  async function loadSettings() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' });
      if (response.success) {
        currentSettings = response.settings;
        applySettings();
      }
    } catch (error) {
      console.error('[Audio Translator] Load settings error:', error);
    }
  }
  
  // 应用设置
  function applySettings() {
    if (!subtitleWindow || !currentSettings) return;
    
    const style = currentSettings.subtitleStyle;
    const windowState = currentSettings.windowState;
    
    // 应用样式
    const container = subtitleWindow.querySelector('.at-subtitle-container');
    if (container) {
      container.style.backgroundColor = style.bgColor;
      container.style.color = style.textColor;
      container.style.fontSize = style.fontSize + 'px';
      container.style.opacity = style.opacity;
    }
    
    // 应用窗口位置和大小
    if (windowState.position.x !== null && windowState.position.y !== null) {
      subtitleWindow.style.left = windowState.position.x + 'px';
      subtitleWindow.style.top = windowState.position.y + 'px';
    }
    
    if (windowState.size) {
      subtitleWindow.style.width = windowState.size.width + 'px';
      subtitleWindow.style.height = windowState.size.height + 'px';
    }
    
    isPinned = windowState.pinned;
    updatePinButton();
  }
  
  // 显示字幕窗
  function showSubtitleWindow() {
    if (subtitleWindow) {
      subtitleWindow.style.display = 'flex';
      return;
    }
    
    // 创建字幕窗
    subtitleWindow = createSubtitleWindow();
    document.body.appendChild(subtitleWindow);
    
    // 应用设置
    applySettings();
    
    // 设置默认位置（右下角）
    const defaultX = window.innerWidth - 420;
    const defaultY = window.innerHeight - 200;
    subtitleWindow.style.left = defaultX + 'px';
    subtitleWindow.style.top = defaultY + 'px';
  }
  
  // 隐藏字幕窗
  function hideSubtitleWindow() {
    if (subtitleWindow) {
      // 保存位置
      saveWindowPosition();
      subtitleWindow.remove();
      subtitleWindow = null;
      subtitleList = [];
    }
  }
  
  // 切换可见性
  function toggleVisibility() {
    if (subtitleWindow) {
      isVisible = !isVisible;
      subtitleWindow.style.display = isVisible ? 'flex' : 'none';
    }
  }
  
  // 创建字幕窗
  function createSubtitleWindow() {
    const wrapper = document.createElement('div');
    wrapper.id = 'audio-translator-subtitle';
    wrapper.className = 'at-subtitle-wrapper';
    
    wrapper.innerHTML = `
      <div class="at-subtitle-container">
        <div class="at-subtitle-header">
          <div class="at-header-left">
            <span class="at-status-indicator"></span>
            <span class="at-title">实时字幕</span>
          </div>
          <div class="at-header-controls">
            <button class="at-btn at-btn-pin" title="置顶">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M16 12V4H17V2H7V4H8V12L6 14V16H11.2V22H12.8V16H18V14L16 12Z"/>
              </svg>
            </button>
            <button class="at-btn at-btn-minimize" title="最小化">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M20 14H4V16H20V14Z"/>
              </svg>
            </button>
            <button class="at-btn at-btn-close" title="关闭">
              <svg viewBox="0 0 24 24" width="14" height="14">
                <path fill="currentColor" d="M19 6.41L17.59 5L12 10.59L6.41 5L5 6.41L10.59 12L5 17.59L6.41 19L12 13.41L17.59 19L19 17.59L13.41 12L19 6.41Z"/>
              </svg>
            </button>
          </div>
        </div>
        <div class="at-subtitle-content">
          <div class="at-subtitle-list"></div>
          <div class="at-status-bar">
            <span class="at-status-text">就绪</span>
          </div>
        </div>
        <div class="at-subtitle-footer">
          <button class="at-btn-text at-btn-clear">清空历史</button>
          <label class="at-auto-scroll-label">
            <input type="checkbox" class="at-auto-scroll-checkbox" checked>
            <span>自动滚动</span>
          </label>
        </div>
      </div>
    `;
    
    // 绑定事件
    bindEvents(wrapper);
    
    return wrapper;
  }
  
  // 绑定事件
  function bindEvents(wrapper) {
    const header = wrapper.querySelector('.at-subtitle-header');
    const closeBtn = wrapper.querySelector('.at-btn-close');
    const minimizeBtn = wrapper.querySelector('.at-btn-minimize');
    const pinBtn = wrapper.querySelector('.at-btn-pin');
    const clearBtn = wrapper.querySelector('.at-btn-clear');
    const autoScrollCheckbox = wrapper.querySelector('.at-auto-scroll-checkbox');
    
    // 拖动功能
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('.at-btn')) return;
      
      isDragging = true;
      const rect = wrapper.getBoundingClientRect();
      dragOffset.x = e.clientX - rect.left;
      dragOffset.y = e.clientY - rect.top;
      
      header.style.cursor = 'grabbing';
    });
    
    document.addEventListener('mousemove', (e) => {
      if (!isDragging || !subtitleWindow) return;
      
      let newX = e.clientX - dragOffset.x;
      let newY = e.clientY - dragOffset.y;
      
      // 限制在视口内
      const maxX = window.innerWidth - wrapper.offsetWidth;
      const maxY = window.innerHeight - wrapper.offsetHeight;
      
      newX = Math.max(0, Math.min(newX, maxX));
      newY = Math.max(0, Math.min(newY, maxY));
      
      wrapper.style.left = newX + 'px';
      wrapper.style.top = newY + 'px';
    });
    
    document.addEventListener('mouseup', () => {
      if (isDragging) {
        isDragging = false;
        header.style.cursor = 'grab';
        saveWindowPosition();
      }
    });
    
    // 关闭按钮
    closeBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' });
      hideSubtitleWindow();
    });
    
    // 最小化按钮
    minimizeBtn.addEventListener('click', () => {
      const content = wrapper.querySelector('.at-subtitle-content');
      const footer = wrapper.querySelector('.at-subtitle-footer');
      
      isMinimized = !isMinimized;
      content.style.display = isMinimized ? 'none' : 'flex';
      footer.style.display = isMinimized ? 'none' : 'flex';
      
      minimizeBtn.innerHTML = isMinimized 
        ? `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M4 10H20V14H4V10Z"/></svg>`
        : `<svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M20 14H4V16H20V14Z"/></svg>`;
    });
    
    // 置顶按钮
    pinBtn.addEventListener('click', () => {
      isPinned = !isPinned;
      updatePinButton();
      saveSettings();
    });
    
    // 清空按钮
    clearBtn.addEventListener('click', () => {
      clearSubtitles();
    });
    
    // 自动滚动开关
    autoScrollCheckbox.addEventListener('change', () => {
      if (currentSettings) {
        currentSettings.subtitleStyle.autoScroll = autoScrollCheckbox.checked;
      }
    });
  }
  
  // 更新置顶按钮状态
  function updatePinButton() {
    if (!subtitleWindow) return;
    const pinBtn = subtitleWindow.querySelector('.at-btn-pin');
    if (pinBtn) {
      pinBtn.classList.toggle('active', isPinned);
      pinBtn.style.opacity = isPinned ? '1' : '0.6';
    }
  }
  
  // 保存窗口位置
  function saveWindowPosition() {
    if (!subtitleWindow || !currentSettings) return;
    
    const rect = subtitleWindow.getBoundingClientRect();
    currentSettings.windowState.position = {
      x: rect.left,
      y: rect.top
    };
    
    saveSettings();
  }
  
  // 保存设置
  async function saveSettings() {
    try {
      await chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        payload: currentSettings
      });
    } catch (error) {
      console.error('[Audio Translator] Save settings error:', error);
    }
  }
  
  // 添加字幕
  function addSubtitle(subtitle) {
    if (!subtitleWindow) return;
    
    subtitleList.push(subtitle);
    
    // 限制历史记录数量
    const maxLines = currentSettings?.subtitleStyle?.maxLines || 5;
    if (subtitleList.length > maxLines) {
      subtitleList.shift();
    }
    
    renderSubtitles();
  }
  
  // 渲染字幕
  function renderSubtitles() {
    if (!subtitleWindow) return;
    
    const listContainer = subtitleWindow.querySelector('.at-subtitle-list');
    if (!listContainer) return;
    
    listContainer.innerHTML = subtitleList.map((item, index) => `
      <div class="at-subtitle-item ${index === subtitleList.length - 1 ? 'latest' : ''}">
        <div class="at-subtitle-translated">${escapeHtml(item.translatedText)}</div>
        ${item.originalText ? `<div class="at-subtitle-original">${escapeHtml(item.originalText)}</div>` : ''}
      </div>
    `).join('');
    
    // 自动滚动
    const autoScroll = subtitleWindow.querySelector('.at-auto-scroll-checkbox')?.checked ?? true;
    if (autoScroll) {
      listContainer.scrollTop = listContainer.scrollHeight;
    }
  }
  
  // 清空字幕
  function clearSubtitles() {
    subtitleList = [];
    renderSubtitles();
  }
  
  // 更新状态
  function updateStatus(payload) {
    if (!subtitleWindow) return;
    
    const statusText = subtitleWindow.querySelector('.at-status-text');
    const statusIndicator = subtitleWindow.querySelector('.at-status-indicator');
    
    if (payload.status === 'translating') {
      if (statusText) statusText.textContent = '翻译中...';
      if (statusIndicator) {
        statusIndicator.className = 'at-status-indicator translating';
      }
    } else if (payload.status === 'error') {
      if (statusText) statusText.textContent = '错误: ' + (payload.message || '未知错误');
      if (statusIndicator) {
        statusIndicator.className = 'at-status-indicator error';
      }
    } else {
      if (statusText) statusText.textContent = '就绪';
      if (statusIndicator) {
        statusIndicator.className = 'at-status-indicator ready';
      }
    }
  }
  
  // HTML 转义
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
  
})();