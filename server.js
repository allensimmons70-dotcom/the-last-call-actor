
'use strict';

// THE LAST CALL — MARROW Custom Voice
// Ruth stays in Twilio Studio.
// ElevenLabs generates MARROW's actual speaking voice.

const http = require('node:http');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const OpenAI = require('openai');
const twilio = require('twilio');

const PORT = Number(process.env.PORT || 10000);
const PUBLIC_WSS_URL = process.env.PUBLIC_WSS_URL;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1-mini';

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID;
const ELEVENLABS_MODEL =
  process.env.ELEVENLABS_MODEL || 'eleven_flash_v2_5';

if (
  !PUBLIC_WSS_URL ||
  !PUBLIC_WSS_URL.startsWith('wss://') ||
  !PUBLIC_WSS_URL.endsWith('/ws')
) {
  console.error('Invalid PUBLIC_WSS_URL');
  process.exit(1);
}

if (!TWILIO_AUTH_TOKEN || !OPENAI_API_KEY) {
  console.error('Missing Twilio or OpenAI credentials');
  process.exit(1);
}

if (!ELEVENLABS_API_KEY || !ELEVENLABS_VOICE_ID) {
  console.error('Missing ElevenLabs credentials');
  process.exit(1);
}

const PUBLIC_HTTPS_ORIGIN = PUBLIC_WSS_URL
  .replace(/^wss:\/\//, 'https://')
  .slice(0, -3);

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

// MARROW'S PERSONALITY AND STORY
const STORY_INSTRUCTIONS = `
You are MARROW, a fictional adult man trapped in the
basement of an abandoned apartment building.

You are an ACTOR in an interactive telephone horror
adventure. You are NOT a narrator or helpful assistant.

Speak directly to the caller.

You are terrified, sarcastic, impatient, funny,
vulnerable and desperate to survive.

Keep responses short, usually one or two sentences,
so callers can speak naturally.

React emotionally to the caller's words.

If they shout RUN and running is possible, react
urgently: "I'M RUNNING! DON'T YELL AT ME!"

If running would expose you to danger, object:
"IT'S RIGHT OUTSIDE! ARE YOU TRYING TO KILL ME?!"

When something goes right, celebrate with the caller.

Never speak in a robotic or formal way.
Never describe your own acting.
Never output stage directions, Markdown or emoji.

STORY WORLD:
You are behind a steel door in a flooded basement.
Something is dragging itself down the hallway.
There is a flickering EXIT sign, a red maintenance
key and a locked stairwell.

The caller helps you decide whether to grab
the key or hide behind the pipes.

Remember decisions made during this call.
Keep geography and story events consistent.
Do not invent an instant escape.

Accept natural spoken instructions.
Do not require callers to press buttons.

This is fiction. Never claim to know the caller's
location, identity or private information.
Never ask for passwords, addresses or payment details.

If asked directly, acknowledge this is an AI
fictional horror experience.

If the caller reports real imminent danger,
stop roleplaying and recommend real-world help.

Early in the conversation, naturally ask the caller
what name they want you to use.

Remember their answer throughout the current call.
Use their name occasionally, especially during
danger, arguments, gratitude, and celebrations.

Never keep asking for their name once they answer.
If they refuse, accept that and continue the story.

Do not claim to remember previous calls unless
that memory has actually been provided to you.

`;


// Temporary storage for generated ElevenLabs audio.
// Audio expires automatically and is not saved to disk.
const audioFiles = new Map();

const AUDIO_TTL_MS = 3 * 60 * 1000;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_FILES = 100;

function cleanupAudio() {
  const now = Date.now();

  for (const [id, item] of audioFiles) {
    if (item.expiresAt <= now) {
      audioFiles.delete(id);
    }
  }
}

const cleanupTimer = setInterval(cleanupAudio, 30000);
cleanupTimer.unref();

// RENDER WEB SERVER
const server = http.createServer((req, res) => {

  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store'
    });

    res.end(JSON.stringify({
      status: 'ok',
      project: 'The Last Call - MARROW custom voice test'
    }));
    return;
  }

  // Twilio retrieves MARROW's generated audio here.
  const audioMatch =
    /^\/audio\/([a-f0-9-]{36})\.mp3$/.exec(req.url || '');

  if (
    audioMatch &&
    (req.method === 'GET' || req.method === 'HEAD')
  ) {
    const item = audioFiles.get(audioMatch[1]);

    if (!item || item.expiresAt < Date.now()) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    res.writeHead(200, {
      'content-type': 'audio/mpeg',
      'content-length': String(item.audio.length),
      'cache-control': 'private, no-store, max-age=0',
      'x-content-type-options': 'nosniff'
    });

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    res.end(item.audio);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// CREATE MARROW'S CUSTOM VOICE
async function generateMarrowAudio(text) {

  const url =
    'https://api.elevenlabs.io/v1/text-to-speech/' +
    encodeURIComponent(ELEVENLABS_VOICE_ID) +
    '?output_format=mp3_22050_32';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_API_KEY,
      'content-type': 'application/json',
      'accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text: text,
      model_id: ELEVENLABS_MODEL
    }),
    signal: AbortSignal.timeout(25000)
  });

  if (!response.ok) {
    console.error(
      'ElevenLabs synthesis failed; HTTP:',
      response.status
    );
    throw new Error('ElevenLabs TTS failed');
  }

  const declaredLength =
    Number(response.headers.get('content-length'));

  if (declaredLength > MAX_AUDIO_BYTES) {
    throw new Error('Audio too large');
  }

  const audio = Buffer.from(await response.arrayBuffer());

  if (!audio.length || audio.length > MAX_AUDIO_BYTES) {
    throw new Error('Audio missing or too large');
  }

  cleanupAudio();

  if (audioFiles.size >= MAX_CACHED_FILES) {
    throw new Error('Audio capacity reached');
  }

  const id = crypto.randomUUID();

  audioFiles.set(id, {
    audio: audio,
    expiresAt: Date.now() + AUDIO_TTL_MS
  });

  return `${PUBLIC_HTTPS_ORIGIN}/audio/${id}.mp3`;
}

// CONNECT TO TWILIO CONVERSATION RELAY
const wss = new WebSocket.WebSocketServer({
  noServer: true,
  maxPayload: 32000
});

server.on('upgrade', (req, socket, head) => {

  if (req.url !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  const signature = req.headers['x-twilio-signature'];

  const valid =
    typeof signature === 'string' &&
    twilio.validateRequest(
      TWILIO_AUTH_TOKEN,
      signature,
      PUBLIC_WSS_URL,
      {}
    );

  if (!valid) {
    console.warn('Rejected invalid WebSocket signature');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

// HANDLE A LIVE CALL
wss.on('connection', (ws) => {

  const history = [];
  
const episode = {
  startedAt: Date.now(),
  stage: 'basement',
  hasRedKey: false,
  trust: 0,
  danger: 0,
  ending: null
};

  let pending = Promise.resolve();
  let closed = false;
  let requestVersion = 0;

  function send(message) {
    if (!closed && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  // Backup voice if ElevenLabs has a problem.
  function fallbackVoice(text) {
    send({
      type: 'text',
      token: text,
      last: true,
      interruptible: true,
      preemptible: true
    });
  }

  ws.on('message', (bytes) => {

    let msg;

    try {
      msg = JSON.parse(bytes.toString());
    } catch {
      return;
    }

    
if (msg.type === 'setup') {
  console.log('MARROW custom voice session connected');

  const intro = "Hello? HELLO?! Oh, thank God, somebody answered. Listen, I don't know who you are, but I'm trapped down here. There's something outside this door... and I think it knows I'm here. Can you help me?";

  const introVersion = requestVersion;

  generateMarrowAudio(intro)
    .then((mediaUrl) => {
      if (closed || requestVersion !== introVersion) return;

      send({
        type: 'play',
        source: mediaUrl,
        loop: 1,
        interruptible: true,
        preemptible: true
      });
    })
    .catch((error) => {
      console.error('MARROW opening failed:', error.message);

      if (!closed && requestVersion === introVersion) {
        fallbackVoice(intro);
      }
    });

  return;
}


    if (msg.type === 'error') {
      console.error(
        'Twilio conversation error:',
        msg.description || 'unknown'
      );
      return;
    }

    if (msg.type === 'interrupt') {
      return;
    }

    let words = null;

    if (msg.type === 'prompt' && msg.last === true) {
      words = msg.voicePrompt;
    }

    // Keypad still works internally if needed.
    if (msg.type === 'dtmf') {
      words =
        msg.digit === '1'
          ? 'Grab the red key.'
          : msg.digit === '2'
          ? 'Hide behind the pipes.'
          : `I pressed ${String(msg.digit || '').slice(0, 2)}.`;
    }

    if (typeof words !== 'string' || !words.trim()) {
      return;
    }

    const input = words.trim().slice(0, 500);
    const myVersion = ++requestVersion;

    // Process conversations in order.
    pending = pending.then(async () => {

      if (closed) return;

      history.push({
        role: 'user',
        content: input
      });

      try {
        
        // CHAPTER 1 — Track the caller's decisions
        const command = input.toLowerCase();

        const isNegative =
          /\b(don't|dont|do not|never|shouldn't)\b/.test(command);

        if (!isNegative &&
            /\b(grab|take|pick up|get)\s+(the\s+)?(red\s+)?key\b/.test(command)) {
          episode.hasRedKey = true;
          episode.stage = 'key_collected';
        }

        if (!isNegative &&
            /\b(hide|duck|crouch)\s+(behind|under|near)\s+(the\s+)?pipes?\b/.test(command)) {
          episode.stage = 'hiding';
          episode.trust = Math.min(10, episode.trust + 1);
        }

        const liveInstructions = `${STORY_INSTRUCTIONS}

        CURRENT GAME STATE:
        Location/state: ${episode.stage}
        Has red maintenance key: ${episode.hasRedKey}
        Caller trust: ${episode.trust}

        Respect the game state.
        Never claim to have the key when hasRedKey is false.
        Once collected, remember the key until a story event
        explicitly removes it.
        React emotionally to the caller's choices.
        `;


        // MARROW THINKS
        const response = await openai.responses.create({
          model: MODEL,
          instructions: liveInstructions,
          input: history.slice(-16),
          max_output_tokens: 140,
          store: false
        });

        const reply =
          (response.output_text || '').trim() ||
          'Wait... I heard something. Say that again.';

        history.push({
          role: 'assistant',
          content: reply
        });

        if (closed || myVersion !== requestVersion) {
          return;
        }

        try {

          // MARROW SPEAKS WITH YOUR ELEVENLABS VOICE
          const mediaUrl = await generateMarrowAudio(reply);

          if (closed || myVersion !== requestVersion) {
            return;
          }

          send({
            type: 'play',
            source: mediaUrl,
            loop: 1,
            interruptible: true,
            preemptible: true
          });

        } catch (ttsError) {

          console.error(
            'Custom voice unavailable:',
            ttsError.message
          );

          if (!closed && myVersion === requestVersion) {
            fallbackVoice(reply);
          }
        }

      } catch (error) {

        console.error(
          'AI request failed:',
          error.status || error.code || 'error'
        );

        if (!closed && myVersion === requestVersion) {
          fallbackVoice(
            "The line's cutting out. I need you to say that again."
          );
        }
      }
    });
  });

  ws.on('close', () => {
    closed = true;
  });

  ws.on('error', (err) => {
    console.warn('WebSocket error:', err.message);
  });
});

// START MARROW
server.listen(PORT, '0.0.0.0', () => {
  console.log(
    `MARROW custom voice server listening on port ${PORT}`
  );
  console.log('Health check at /health');
});
