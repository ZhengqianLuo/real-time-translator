const { ipcRenderer } = require('electron');

const subtitleList = document.getElementById('subtitleList');
const closeBtn = document.getElementById('closeBtn');
const clearBtn = document.getElementById('clearBtn');
const fontDownBtn = document.getElementById('fontDownBtn');
const fontUpBtn = document.getElementById('fontUpBtn');

const MAX_ARTICLE_SEGMENTS = 1000;
const FONT_STEP = 2;
const MIN_FONT_SIZE = 16;
const MAX_FONT_SIZE = 48;
const EVENT_TRANSLATION_PARTIAL = 654;
const EVENT_TRANSLATION_FINAL = 655;

let articleSegments = [];
let currentSegment = '';
let fontSize = Number(localStorage.getItem('floatingSubtitleFontSize') || 24);

function updateSubtitle(subtitle) {
  const translation = (subtitle.translation || '').trim();
  const event = Number(subtitle.event);

  if (!translation) {
    return;
  }

  if (event === EVENT_TRANSLATION_FINAL) {
    commitSegment(translation);
    currentSegment = '';
  } else if (event === EVENT_TRANSLATION_PARTIAL) {
    currentSegment = translation;
  } else {
    commitSegment(translation);
  }

  renderSubtitle();
}

function commitSegment(text) {
  const normalized = normalizeSegment(text);
  if (!normalized) {
    return;
  }

  const last = articleSegments[articleSegments.length - 1];
  if (last === normalized) {
    return;
  }

  articleSegments.push(normalized);
  if (articleSegments.length > MAX_ARTICLE_SEGMENTS) {
    articleSegments = articleSegments.slice(-MAX_ARTICLE_SEGMENTS);
  }
}

function normalizeSegment(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function renderSubtitle() {
  if (articleSegments.length === 0 && !currentSegment) {
    subtitleList.innerHTML = '<div class="placeholder">等待翻译开始...</div>';
    return;
  }

  const shouldStickToBottom =
    subtitleList.scrollHeight - subtitleList.scrollTop - subtitleList.clientHeight < 80;

  const finalizedHtml = articleSegments
    .map(segment => `<span class="subtitle-segment">${escapeHtml(segment)}</span>`)
    .join('');
  const currentHtml = currentSegment
    ? `<span class="subtitle-current">${escapeHtml(normalizeSegment(currentSegment))}</span>`
    : '';

  subtitleList.innerHTML = `<article class="subtitle-article">${finalizedHtml}${currentHtml}</article>`;

  if (shouldStickToBottom) {
    subtitleList.scrollTop = subtitleList.scrollHeight;
  }
}

function clearSubtitles() {
  articleSegments = [];
  currentSegment = '';
  renderSubtitle();
}

function applyFontSize() {
  fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, fontSize));
  document.documentElement.style.setProperty('--subtitle-font-size', `${fontSize}px`);
  localStorage.setItem('floatingSubtitleFontSize', String(fontSize));
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

closeBtn.addEventListener('click', () => {
  ipcRenderer.invoke('hide-floating');
});

clearBtn.addEventListener('click', () => {
  clearSubtitles();
});

fontDownBtn.addEventListener('click', () => {
  fontSize -= FONT_STEP;
  applyFontSize();
});

fontUpBtn.addEventListener('click', () => {
  fontSize += FONT_STEP;
  applyFontSize();
});

ipcRenderer.on('update-subtitle', (event, subtitle) => {
  updateSubtitle(subtitle);
});

applyFontSize();
