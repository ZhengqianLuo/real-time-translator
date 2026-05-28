const WebSocket = require('ws');
const http = require('http');
const url = require('url');
const path = require('path');
const protobuf = require('protobufjs');

// 豆包同传 WebSocket 地址
const DOUBAO_WS_URL = 'wss://openspeech.bytedance.com/api/v4/ast/v2/translate';
const PROTO_ROOT = path.join(__dirname, 'protos');
const PROTO_PATH = path.join(PROTO_ROOT, 'products', 'understanding', 'ast', 'ast_service.proto');
const protoRoot = new protobuf.Root();
protoRoot.resolvePath = (origin, target) => path.isAbsolute(target) ? target : path.join(PROTO_ROOT, target);
protoRoot.loadSync(PROTO_PATH);
protoRoot.resolveAll();
const AstRequest = protoRoot.lookupType('data.speech.ast.TranslateRequest');
const AstResponse = protoRoot.lookupType('data.speech.ast.TranslateResponse');

const PROTOCOL_VERSION = 0x1;
const DEFAULT_HEADER_SIZE = 0x1;
const CLIENT_FULL_REQUEST = 0x1;
const SERVER_FULL_RESPONSE = 0x9;
const SERVER_ERROR_RESPONSE = 0xf;
const PROTOBUF_SERIALIZATION = 0x2;
const NO_COMPRESSION = 0x0;

function makeFrame(payload, messageType = CLIENT_FULL_REQUEST) {
  const header = Buffer.from([
    (PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE,
    (messageType << 4) | 0x0,
    (PROTOBUF_SERIALIZATION << 4) | NO_COMPRESSION,
    0x00
  ]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, size, payload]);
}

function parseFrame(data) {
  const buffer = Buffer.from(data);
  if (buffer.length < 8) {
    return { payload: buffer, messageType: null };
  }

  const protocolVersion = buffer[0] >> 4;
  const headerSize = buffer[0] & 0x0f;
  const headerLength = headerSize * 4;
  const messageType = buffer[1] >> 4;

  if (protocolVersion !== PROTOCOL_VERSION || headerSize < 1 || buffer.length < headerLength + 4) {
    return { payload: buffer, messageType: null };
  }

  const payloadSize = buffer.readUInt32BE(headerLength);
  const payloadStart = headerLength + 4;
  const payloadEnd = payloadStart + payloadSize;
  const payload = buffer.subarray(payloadStart, Math.min(payloadEnd, buffer.length));

  return { payload, messageType };
}

function compactObject(value) {
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) {
    return value;
  }

  for (const key of Object.keys(value)) {
    if (value[key] === undefined || value[key] === null || value[key] === '') {
      delete value[key];
    } else {
      compactObject(value[key]);
    }
  }

  return value;
}

function normalizeRequest(message) {
  const sessionId = message.request_meta?.session_id;
  const sourceAudio = message.source_audio ? { ...message.source_audio } : undefined;
  const request = message.request ? {
    mode: message.request.mode,
    sourceLanguage: message.request.source_language,
    targetLanguage: message.request.target_language,
    speakerId: message.request.speaker_id,
  } : undefined;
  const user = message.user ? {
    uid: message.user.uid,
    did: message.user.did,
    platform: message.user.platform,
    sdkVersion: message.user.sdk_version,
  } : undefined;

  if (sourceAudio && typeof sourceAudio.data === 'string') {
    sourceAudio.binaryData = Buffer.from(sourceAudio.data, 'base64');
    delete sourceAudio.data;
  }

  const normalized = {
    requestMeta: sessionId ? {
      SessionID: sessionId
    } : undefined,
    event: message.event,
    user,
    sourceAudio,
    targetAudio: message.target_audio,
    request,
  };

  return compactObject(normalized);
}

function encodeAstRequest(message) {
  const payload = normalizeRequest(message);
  const error = AstRequest.verify(payload);
  if (error) {
    throw new Error(`Invalid AST request: ${error}`);
  }
  return AstRequest.encode(AstRequest.create(payload)).finish();
}

function decodeAstResponse(data) {
  const frame = parseFrame(data);
  if (frame.messageType === SERVER_ERROR_RESPONSE) {
    throw new Error(frame.payload.toString('utf8'));
  }

  const buffer = frame.messageType === SERVER_FULL_RESPONSE ? frame.payload : Buffer.from(data);
  const errors = [];

  for (let offset = 0; offset < Math.min(32, buffer.length); offset++) {
    try {
      const response = AstResponse.decode(buffer.subarray(offset));
      const object = AstResponse.toObject(response, {
        longs: String,
        enums: Number,
        bytes: String,
        defaults: false
      });

      if (object.event || object.text || object.responseMeta?.statusCode || object.responseMeta?.message) {
        if (offset > 0) {
          console.log('[Proxy] Decoded Doubao response with frame offset:', offset);
        }
        return object;
      }
    } catch (error) {
      errors.push(`${offset}:${error.message}`);
    }
  }

  console.error('[Proxy] Doubao response hex:', buffer.subarray(0, 64).toString('hex'));
  throw new Error(errors.slice(0, 5).join(' | '));
}

function getSafeCloseCode(code) {
  return code >= 1000 && code < 5000 && ![1004, 1005, 1006].includes(code) ? code : 1011;
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // 健康检查端点
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  res.writeHead(404);
  res.end('Not Found');
});

// 创建 WebSocket 服务器
const wss = new WebSocket.Server({ server });

wss.on('connection', (clientWs, req) => {
  console.log('[Proxy] New client connection');

  // 从 URL 参数获取鉴权信息
  const query = url.parse(req.url, true).query;
  const apiKey = query.api_key;
  const resourceId = query.resource_id || 'volc.service_type.10053';

  if (!apiKey) {
    console.error('[Proxy] Missing api_key');
    clientWs.close(1008, 'Missing api_key');
    return;
  }

  console.log('[Proxy] Connecting to Doubao with resource:', resourceId);

  // 连接到豆包同传 WebSocket，添加鉴权头
  const doubaoWs = new WebSocket(DOUBAO_WS_URL, {
    headers: {
      'X-Api-Key': apiKey,
      'X-Api-Resource-Id': resourceId
    }
  });

  // 监听意外响应事件（用于调试）
  doubaoWs.on('unexpected-response', (req, res) => {
    console.error('[Proxy] Unexpected response from Doubao:');
    console.error('[Proxy] Status code:', res.statusCode);
    console.error('[Proxy] Status message:', res.statusMessage);
    console.error('[Proxy] Headers:', res.headers);
    
    let body = '';
    res.on('data', (chunk) => {
      body += chunk;
    });
    res.on('end', () => {
      console.error('[Proxy] Response body:', body);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1011, body || `Upstream rejected with ${res.statusCode}`);
      }
    });
  });

  let doubaoConnected = false;
  const pendingPayloads = [];
  const heartbeatTimer = setInterval(() => {
    try {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.ping();
      }
      if (doubaoWs.readyState === WebSocket.OPEN) {
        doubaoWs.ping();
      }
    } catch (error) {
      console.error('[Proxy] Heartbeat failed:', error.message);
    }
  }, 20000);

  // 豆包连接成功
  doubaoWs.on('open', () => {
    console.log('[Proxy] Connected to Doubao');
    doubaoConnected = true;
    while (pendingPayloads.length > 0 && doubaoWs.readyState === WebSocket.OPEN) {
      doubaoWs.send(pendingPayloads.shift());
    }
  });

  // 从豆包接收消息，转发给客户端
  doubaoWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      try {
        const response = decodeAstResponse(data);
        console.log('[Proxy] Doubao event:', response.event, response.text || response.responseMeta?.message || '');
        if (response.event === 153) {
          console.log('[Proxy] Doubao failure detail:', JSON.stringify(response));
        }
        clientWs.send(JSON.stringify(response));
      } catch (error) {
        console.error('[Proxy] Failed to decode Doubao response:', error.message);
        clientWs.send(data.toString());
      }
    }
  });

  // 豆包连接错误
  doubaoWs.on('error', (error) => {
    console.error('[Proxy] Doubao WebSocket error:', error.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(1011, 'Upstream connection error');
    }
  });

  // 豆包连接关闭
  doubaoWs.on('close', (code, reason) => {
    console.log('[Proxy] Doubao connection closed:', code, reason);
    doubaoConnected = false;
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close(getSafeCloseCode(code), reason);
    }
  });

  // 从客户端接收消息，转发给豆包
  clientWs.on('message', (data) => {
    try {
      // 尝试解析为 JSON
      const message = JSON.parse(data.toString());
      const payload = encodeAstRequest(message);
      console.log('[Proxy] Client event:', message.event, message.source_audio?.data ? `audio=${message.source_audio.data.length}` : '');

      if (doubaoWs.readyState === WebSocket.OPEN) {
        doubaoWs.send(payload);
      } else if (doubaoWs.readyState === WebSocket.CONNECTING) {
        pendingPayloads.push(payload);
        console.log('[Proxy] Queued client event until upstream opens:', message.event);
      } else {
        throw new Error('Upstream WebSocket is not open');
      }
    } catch (e) {
      console.error('[Proxy] Failed to encode client message:', e.message);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.close(1003, e.message);
      }
    }
  });

  // 客户端连接错误
  clientWs.on('error', (error) => {
    console.error('[Proxy] Client WebSocket error:', error.message);
  });

  // 客户端连接关闭
  clientWs.on('close', (code, reason) => {
    console.log('[Proxy] Client connection closed:', code, reason);
    clearInterval(heartbeatTimer);
    if (doubaoWs.readyState === WebSocket.OPEN) {
      doubaoWs.close();
    }
  });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[Proxy] Server running on port ${PORT}`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('[Proxy] SIGTERM received, closing server...');
  server.close(() => {
    console.log('[Proxy] Server closed');
    process.exit(0);
  });
});

module.exports = server;
