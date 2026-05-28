// Options 脚本 - 设置页面逻辑

document.addEventListener('DOMContentLoaded', async () => {
  // 获取 DOM 元素
  const providerSelect = document.getElementById('provider');
  const apiKeyInput = document.getElementById('apiKey');
  const toggleApiKeyBtn = document.getElementById('toggleApiKey');
  const sourceLanguageSelect = document.getElementById('sourceLanguage');
  const targetLanguageSelect = document.getElementById('targetLanguage');
  const fontSizeRange = document.getElementById('fontSize');
  const fontSizeValue = document.getElementById('fontSizeValue');
  const maxLinesRange = document.getElementById('maxLines');
  const maxLinesValue = document.getElementById('maxLinesValue');
  const opacityRange = document.getElementById('opacity');
  const opacityValue = document.getElementById('opacityValue');
  const autoScrollCheckbox = document.getElementById('autoScroll');
  const saveBtn = document.getElementById('saveBtn');
  const resetBtn = document.getElementById('resetBtn');
  const messageDiv = document.getElementById('message');

  // 豆包 HTTP 模式相关元素
  const doubaoEndpointGroup = document.getElementById('doubaoEndpointGroup');
  const doubaoEndpointInput = document.getElementById('doubaoEndpoint');
  const doubaoModelGroup = document.getElementById('doubaoModelGroup');
  const doubaoModelInput = document.getElementById('doubaoModel');

  // 豆包同传 WebSocket 模式相关元素
  const doubaoAstGroup = document.getElementById('doubaoAstGroup');
  const appKeyInput = document.getElementById('appKey');
  const toggleAppKeyBtn = document.getElementById('toggleAppKey');
  const doubaoResourceIdGroup = document.getElementById('doubaoResourceIdGroup');
  const resourceIdInput = document.getElementById('resourceId');
  const apiKeyGroup = document.getElementById('apiKeyGroup');

  // 默认设置
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
    },
    // 豆包 HTTP 模式配置
    doubaoEndpoint: 'https://ark.cn-beijing.volces.com/api/v3',
    doubaoModel: ''
  };

  // 当前设置
  let currentSettings = null;

  // 初始化
  await loadSettings();
  bindEvents();

  // 加载设置
  async function loadSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      currentSettings = settings || defaultSettings;

      // 填充表单
      providerSelect.value = currentSettings.provider || 'openai';
      apiKeyInput.value = currentSettings.apiKey || '';
      sourceLanguageSelect.value = currentSettings.sourceLanguage || 'id';
      targetLanguageSelect.value = currentSettings.targetLanguage || 'zh';

      const style = currentSettings.subtitleStyle || defaultSettings.subtitleStyle;
      fontSizeRange.value = style.fontSize || 14;
      fontSizeValue.textContent = (style.fontSize || 14) + 'px';
      maxLinesRange.value = style.maxLines || 5;
      maxLinesValue.textContent = (style.maxLines || 5) + '行';
      opacityRange.value = style.opacity || 0.75;
      opacityValue.textContent = Math.round((style.opacity || 0.75) * 100) + '%';
      autoScrollCheckbox.checked = style.autoScroll !== false;

      // 豆包 HTTP 模式配置
      doubaoEndpointInput.value = currentSettings.doubaoEndpoint || defaultSettings.doubaoEndpoint;
      doubaoModelInput.value = currentSettings.doubaoModel || '';

      // 豆包同传 WebSocket 模式配置
      appKeyInput.value = currentSettings.appKey || '';
      resourceIdInput.value = currentSettings.resourceId || defaultSettings.resourceId;

      // 根据提供商显示/隐藏配置字段
      toggleProviderFields();

    } catch (error) {
      console.error('Load settings error:', error);
      showMessage('加载设置失败', 'error');
    }
  }

  // 根据提供商切换字段显示
  function toggleProviderFields() {
    const provider = providerSelect.value;
    const isDoubaoHttp = provider === 'doubao';
    const isDoubaoAst = provider === 'doubao-ast';
    const isDoubao = isDoubaoHttp || isDoubaoAst;

    // 豆包 HTTP 模式字段
    doubaoEndpointGroup.style.display = isDoubaoHttp ? 'block' : 'none';
    doubaoModelGroup.style.display = isDoubaoHttp ? 'block' : 'none';

    // 豆包同传 WebSocket 模式字段
    doubaoAstGroup.style.display = isDoubaoAst ? 'block' : 'none';
    doubaoResourceIdGroup.style.display = isDoubaoAst ? 'block' : 'none';

    // 通用 API Key 字段（非豆包同传模式显示）
    apiKeyGroup.style.display = isDoubaoAst ? 'none' : 'block';
  }

  // 绑定事件
  function bindEvents() {
    // API Key 显示/隐藏切换
    toggleApiKeyBtn.addEventListener('click', () => {
      const type = apiKeyInput.type === 'password' ? 'text' : 'password';
      apiKeyInput.type = type;
    });

    // App Key 显示/隐藏切换
    if (toggleAppKeyBtn) {
      toggleAppKeyBtn.addEventListener('click', () => {
        const type = appKeyInput.type === 'password' ? 'text' : 'password';
        appKeyInput.type = type;
      });
    }

    // 提供商切换
    providerSelect.addEventListener('change', toggleProviderFields);

    // 滑块值更新
    fontSizeRange.addEventListener('input', () => {
      fontSizeValue.textContent = fontSizeRange.value + 'px';
    });

    maxLinesRange.addEventListener('input', () => {
      maxLinesValue.textContent = maxLinesRange.value + '行';
    });

    opacityRange.addEventListener('input', () => {
      opacityValue.textContent = Math.round(opacityRange.value * 100) + '%';
    });

    // 保存按钮
    saveBtn.addEventListener('click', saveSettings);

    // 重置按钮
    resetBtn.addEventListener('click', resetSettings);
  }

  // 保存设置
  async function saveSettings() {
    try {
      const provider = providerSelect.value;
      const newSettings = {
        apiKey: apiKeyInput.value.trim(),
        appKey: appKeyInput ? appKeyInput.value.trim() : '',
        resourceId: resourceIdInput ? resourceIdInput.value.trim() : 'volc.service_type.10053',
        provider: provider,
        sourceLanguage: sourceLanguageSelect.value,
        targetLanguage: targetLanguageSelect.value,
        subtitleStyle: {
          opacity: parseFloat(opacityRange.value),
          bgColor: `rgba(0, 0, 0, ${opacityRange.value})`,
          textColor: '#FFFFFF',
          fontSize: parseInt(fontSizeRange.value),
          maxLines: parseInt(maxLinesRange.value),
          autoScroll: autoScrollCheckbox.checked
        },
        windowState: currentSettings?.windowState || defaultSettings.windowState,
        // 豆包 HTTP 模式配置
        doubaoEndpoint: doubaoEndpointInput.value.trim() || defaultSettings.doubaoEndpoint,
        doubaoModel: doubaoModelInput.value.trim()
      };

      // 验证配置
      if (provider === 'doubao' && !newSettings.doubaoModel) {
        showMessage('请填写豆包模型 ID', 'error');
        return;
      }

      if (provider === 'doubao-ast' && !newSettings.appKey) {
        showMessage('请填写豆包同传 App Key', 'error');
        return;
      }

      if (provider !== 'doubao-ast' && !newSettings.apiKey) {
        showMessage('请填写 API Key', 'error');
        return;
      }

      await chrome.storage.local.set({ settings: newSettings });
      currentSettings = newSettings;

      showMessage('设置已保存', 'success');

      // 通知 background 设置已更新
      chrome.runtime.sendMessage({
        type: 'SAVE_SETTINGS',
        payload: newSettings
      });

    } catch (error) {
      console.error('Save settings error:', error);
      showMessage('保存失败: ' + error.message, 'error');
    }
  }

  // 重置设置
  async function resetSettings() {
    if (!confirm('确定要恢复默认设置吗？')) {
      return;
    }

    try {
      await chrome.storage.local.set({ settings: defaultSettings });
      currentSettings = defaultSettings;

      // 重新加载表单
      providerSelect.value = defaultSettings.provider;
      apiKeyInput.value = defaultSettings.apiKey;
      appKeyInput.value = defaultSettings.appKey;
      resourceIdInput.value = defaultSettings.resourceId;
      sourceLanguageSelect.value = defaultSettings.sourceLanguage;
      targetLanguageSelect.value = defaultSettings.targetLanguage;

      const style = defaultSettings.subtitleStyle;
      fontSizeRange.value = style.fontSize;
      fontSizeValue.textContent = style.fontSize + 'px';
      maxLinesRange.value = style.maxLines;
      maxLinesValue.textContent = style.maxLines + '行';
      opacityRange.value = style.opacity;
      opacityValue.textContent = Math.round(style.opacity * 100) + '%';
      autoScrollCheckbox.checked = style.autoScroll;

      doubaoEndpointInput.value = defaultSettings.doubaoEndpoint;
      doubaoModelInput.value = defaultSettings.doubaoModel;

      toggleProviderFields();

      showMessage('已恢复默认设置', 'success');

    } catch (error) {
      console.error('Reset settings error:', error);
      showMessage('重置失败: ' + error.message, 'error');
    }
  }

  // 显示消息
  function showMessage(text, type) {
    messageDiv.textContent = text;
    messageDiv.className = 'message ' + type;

    setTimeout(() => {
      messageDiv.className = 'message';
    }, 3000);
  }
});
