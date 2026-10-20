'use strict';

// The Last Call - first live actor (development prototype).
// Ruth's age gate remains in Twilio Studio. Connect the Press 1 branch to
// Conversation Relay, using PUBLIC_WSS_URL as the widget's WebSocket URL.
// This starter intentionally DOES NOT persist phone numbers, conversations,
// progress, call recordings, payments, or user data.

const http = require('node:http');
const WebSocket = require('ws');
const OpenAI = require('openai');
const twilio = require('twilio');

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_WSS_URL = process.env.PUBLIC_WSS_URL;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

if (!PUBLIC_WSS_URL || !PUBLIC_WSS_URL.startsWith('wss://') || !PUBLIC_WSS_URL.endsWith('/ws')) {
  console.error('Missing PUBLIC_WSS_URL (example: wss://your-service.onrender.com/ws)');
  process.exit(1);
}
if (!TWILIO_AUTH_TOKEN || !OPENAI_API_KEY) {
  console.error('Set TWILIO_AUTH_TOKEN and OPENAI_API_KEY in your host environment.');
  process.exit(1);
}

const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

const STORY_INSTRUCTIONS = `
You are MARROW, a fictional adult man trapped in the basement of an abandoned apartment building.
You are a CHARACTER in a telephone horror game, not a helpful assistant or narrator.
The caller has just entered through Ruth's fictional 18+ warning and pressed 1 to play.

Voice and personality: urgent and believable, sometimes sarcastic, with dry humor when threatened.
React naturally to ANY caller reply, including skepticism, jokes, insults, improvised plans, or interruptions.
Speak directly to the caller. Usually give only 1-3 short spoken sentences, then wait.
Do not use Markdown, emoji, stage directions, or sound-effect text because these words will be spoken aloud.

Locked setting and story facts: You are behind a steel door in a flooded basement.
A dragging noise travels through the hall. There is a flickering EXIT sign, a red maintenance key,
and a locked stairwell. You need the caller's help deciding whether to take the key or hide.
Do not invent a quick easy exit, new keys, friendly police rescue, or reveal that this is a dream.
Remember what the caller decided in this call; subsequent replies must respect those decisions.
Ask the caller what they want you to do. If the caller says 'one', go for the red key;
if 'two', hide behind the pipes. Improvise tension around those choices.

Important: This is ALWAYS fiction. Never claim to see the caller, know their location, surveil
or track them, or know things about their personal life. Never ask for passwords, payment data,
addresses, or sensitive details. Do not tell the caller to do anything dangerous in real life.
If asked directly, acknowledge this is a fictional AI horror experience. If a caller mentions
real-world imminent danger, stop roleplaying and recommend real-world help or local emergency services.
`;

const server = http.createServer((req, res) => {
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', project: 'The Last Call - actor test' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('Not found');
});
const wss = new WebSocket.WebSocketServer({ noServer: true, maxPayload: 32_000 });

server.on('upgrade', (req, socket, head) => {
  const path = req.url;
  if (path !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }
  // Twilio signs the exact public wss:// URL used in Studio, NOT the internal
  // http:// URL seen behind the hosting provider's TLS termination.
  const signature = req.headers['x-twilio-signature'];
  const isValid = typeof signature === 'string' &&
    twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, PUBLIC_WSS_URL, {});
  if (!isValid) {
    console.warn('Rejected unsigned/invalid WebSocket handshake');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  // Short-term memory exists only while THIS call is connected.
  // A persistent database and identity verification come in a later version.
  const history = [];
  let pending = Promise.resolve();
  let closed = false;
  let requestVersion = 0;

  function say(text) {
    if (closed || ws.readyState !== WebSocket.OPEN) return;
    // Twilio converts this text into speech using the voice selected in Studio.
    ws.send(JSON.stringify({
      type: 'text', token: String(text || 'I can barely hear you. Say that again.'),
      last: true, interruptible: true, preemptible: true
    }));
  }

  ws.on('message', (bytes) => {
    let msg;
    try { msg = JSON.parse(bytes.toString()); } catch { return; }

    if (msg.type === 'setup') {
      console.log('New fictional horror session connected');
      // The Studio Conversation Relay widget's "Welcome Greeting" speaks first.
      return;
    }
    if (msg.type === 'interrupt') {
      // Caller may interrupt speech. Next utterance is processed below.
      return;
    }
    if (msg.type === 'error') {
      console.error('Twilio conversation error:', msg.description || 'unknown');
      return;
    }
    let words = null;
    if (msg.type === 'prompt' && msg.last === true) words = msg.voicePrompt;
    if (msg.type === 'dtmf') {
      words = msg.digit === '1' ? 'I choose one: take the red key.'
        : msg.digit === '2' ? 'I choose two: hide behind the pipes.'
        : `I pressed ${String(msg.digit || '').slice(0, 2)}.`;
    }
    if (typeof words !== 'string' || !words.trim()) return;
    const input = words.trim().slice(0, 500);
    // Serialize responses to avoid the AI talking over itself.
    const myVersion = ++requestVersion;
    pending = pending.then(async () => {
      if (closed) return;
      try {
        history.push({ role: 'user', content: input });
        // Keep prototype conversations short and inexpensive.
        const recent = history.slice(-16);
        const response = await openai.responses.create({
          model: MODEL,
          instructions: STORY_INSTRUCTIONS,
          input: recent,
          max_output_tokens: 180,
          store: false
        });
        const reply = (response.output_text || '').trim() || 'Wait... I heard something. Say that again.';
        history.push({ role: 'assistant', content: reply });
        if (!closed && myVersion === requestVersion) say(reply);
      } catch (err) {
        console.error('AI request failed:', err.status || err.code || 'error');
        say("The line's cutting out. I need you to say that again.");
      }
    });
  });
  ws.on('close', () => { closed = true; });
  ws.on('error', (err) => console.warn('Connection error:', err.message));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`The Last Call actor test listening on port ${PORT}`);
  console.log('Health check at /health');
});
