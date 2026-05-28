// Popup 脚本 - 控制面板逻辑

document.addEventListener('DOMContentLoaded', async () => {
  // 获取 DOM 元素
  const statusIndicator = document.getElementById('statusIndicator');
  const statusText = document.getElementById('statusText');
  const statusDot = document.querySelector('.status-dot');
  const toggleBtn = document.getElementById('toggleBtn');
  const toggleBtnText = document.getElementById('toggleBtnText');
  const hideBtn = document.getElementById('hideBtn');
  const apiStatus = document.getElementById('apiStatus');
  const apiStatusText = document.querySelector('.api-status-text');
  const settingsLink = document.getElementById('settingsLink');
  
  // 当前状态
  let isCapturing = false;
  let settings = null;
  
  // 初始化
  await init();
  
  async function init() {
    // 获取当前标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // 获取捕获状态
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_CAPTURE_STATUS'
      });
      isCapturing = response.isCapturing;
    } catch (error) {
      console.error('Get status error:', error);
    }
    
    // 获取设置
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_SETTINGS'
      });
      if (response.success) {
        settings = response.settings;
        updateApiStatus();
      }
    } catch (error) {
      console.error('Get settings error:', error);
    }
    
    // 更新 UI
    updateUI();
    
    // 绑定事件
    bindEvents(tab);
  }
  
  function updateUI() {
    if (isCapturing) {
      statusText.textContent = '翻译中';
      statusDot.classList.add('active');
      toggleBtnText.textContent = '停止翻译';
      toggleBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M6 6h12v12H6z"/>
        </svg>
        <span>停止翻译</span>
      `;
    } else {
      statusText.textContent = '未开始';
      statusDot.classList.remove('active');
      toggleBtnText.textContent = '开始翻译';
      toggleBtn.innerHTML = `
        <svg viewBox="0 0 24 24" width="16" height="16">
          <path fill="currentColor" d="M8 5v14l11-7z"/>
        </svg>
        <span>开始翻译</span>
      `;
    }
  }
  
  function updateApiStatus() {
    // 检查 API Key 是否已配置
    chrome.storage.local.get('settings', (data) => {
      const settings = data.settings || {};
      const hasApiKey = settings.apiKey && settings.apiKey.length > 0;
      const hasAppKey = settings.appKey && settings.appKey.length > 0;
      const provider = settings.provider || 'openai';

      // 检查配置是否有效
      let isConfigValid = false;
      let statusMessage = '';
      
      if (provider === 'doubao-ast') {
        // 豆包同传模式检查 appKey
        isConfigValid = hasAppKey;
        statusMessage = isConfigValid ? '' : '请先配置豆包同传 App Key';
      } else if (provider === 'doubao') {
        // 豆包 HTTP 模式检查 apiKey 和 model
        isConfigValid = hasApiKey && !!settings.doubaoModel;
        if (!hasApiKey) {
          statusMessage = '请先配置 API Key';
        } else if (!settings.doubaoModel) {
          statusMessage = '请配置豆包模型 ID';
        }
      } else {
        // 其他模式检查 apiKey
        isConfigValid = hasApiKey;
        statusMessage = '请先配置 API Key';
      }

      if (isConfigValid) {
        apiStatus.classList.add('configured');
        const providerName = getProviderDisplayName(provider);
        apiStatus.innerHTML = `
          <span class="api-status-icon">✓</span>
          <span class="api-status-text">API 已配置 (${providerName})</span>
        `;
        toggleBtn.disabled = false;
      } else {
        apiStatus.classList.remove('configured');
        apiStatus.innerHTML = `
          <span class="api-status-icon">⚠️</span>
          <span class="api-status-text">${statusMessage}</span>
        `;
        toggleBtn.disabled = true;
      }
    });
  }

  function getProviderDisplayName(provider) {
    const names = {
      'openai': 'OpenAI',
      'doubao': '豆包',
      'doubao-ast': '豆包同传',
      'claude': 'Claude',
      'gemini': 'Gemini'
    };
    return names[provider] || provider;
  }
  
  function bindEvents(tab) {
    // 开始/停止按钮
    toggleBtn.addEventListener('click', async () => {
      if (isCapturing) {
        // 停止捕获
        try {
          await chrome.runtime.sendMessage({
            type: 'STOP_CAPTURE',
            payload: { tabId: tab.id }
          });
          isCapturing = false;
          updateUI();
        } catch (error) {
          console.error('Stop capture error:', error);
          showError('停止失败: ' + error.message);
        }
      } else {
        // 开始捕获
        try {
          toggleBtn.disabled = true;
          toggleBtnText.textContent = '启动中...';
          
          const response = await chrome.runtime.sendMessage({
            type: 'START_CAPTURE',
            payload: { tabId: tab.id }
          });
          
          if (response.success) {
            isCapturing = true;
            updateUI();
            // 关闭 popup
            window.close();
          } else {
            showError(response.error || '启动失败');
            toggleBtn.disabled = false;
            updateUI();
          }
        } catch (error) {
          console.error('Start capture error:', error);
          showError('启动失败: ' + error.message);
          toggleBtn.disabled = false;
          updateUI();
        }
      }
    });
    
    // 显示/隐藏字幕按钮
    hideBtn.addEventListener('click', async () => {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'TOGGLE_SUBTITLE_VISIBILITY'
        });
      } catch (error) {
        console.error('Toggle subtitle error:', error);
      }
    });
    
    // 设置链接
    settingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
  }
  
  function showError(message) {
    statusText.textContent = message;
    statusText.style.color = '#F44336';
    setTimeout(() => {
      statusText.style.color = '';
      updateUI();
    }, 3000);
  }
});