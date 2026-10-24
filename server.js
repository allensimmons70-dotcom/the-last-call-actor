
'use strict';

// THE LAST CALL — MARROW Custom Voice
// Ruth stays in Twilio Studio.
// ElevenLabs generates MARROW's actual speaking voice.


const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const WebSocket = require('ws');
const OpenAI = require('openai');
const { createDirector } = require('./listener-director');
const { getListenerSound } = require('./listener-sounds');
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
Your adventure begins behind a steel door in a flooded basement. Your current location is determined by CURRENT GAME STATE.
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
  
 
  // THE LISTENER — Real MP3 sound library

  const realSounds = {
    knocks: 'Grand entrance — Three knocks.mp3',
    roar: 'The roar.mp3',
    chain: 'Dragging chains.mp3',
    boom_a: 'Boom A.mp3',
    boom_b: 'Boom B.mp3'
  };

  const realSoundMatch =
    /^\/sfx\/(knocks|roar|chain|boom_a|boom_b)\.mp3$/
      .exec((req.url || '').split('?')[0]);

  if (realSoundMatch) {
    const name = realSoundMatch[1];

    try {
      const filePath = path.join(
        __dirname,
        realSounds[name]
      );

      const audio = fs.readFileSync(filePath);

      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': audio.length,
        'Cache-Control': 'no-store'
      });

      console.log('[REAL LISTENER SOUND]', name);

      return req.method === 'HEAD'
        ? res.end()
        : res.end(audio);

    } catch (error) {
      console.error(
        '[SOUND NOT FOUND]',
        name,
        error.message
      );

      res.writeHead(404);
      return res.end('Sound file missing');
    }
  }
  // THE LISTENER — Public sound effects
  // Must run BEFORE the normal 404 handler.

  const soundRequestPath = (req.url || '').split('?')[0];

  if (soundRequestPath.startsWith('/sfx/')) {
    const match = /^\/sfx\/([a-z]+)\.wav$/.exec(
      soundRequestPath
    );

    const audio = match
      ? getListenerSound(match[1])
      : null;

    if (!audio) {
      res.writeHead(404, {
        'Content-Type': 'text/plain'
      });
      return res.end('Unknown sound');
    }

    res.writeHead(200, {
      'Content-Type': 'audio/wav',
      'Content-Length': audio.length,
      'Cache-Control': 'public, max-age=3600'
    });

    console.log('[SFX HTTP]', soundRequestPath);

    if (req.method === 'HEAD') {
      return res.end();
    }

    return res.end(audio);
  }



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

const director = createDirector({
  maxDurationMs: 270000,
  keypadDurationMs: 90000
});

  
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
  
  let handoffSent = false;

  function finishChapter(outcome) {
    if (closed || handoffSent) return;

    handoffSent = true;
    requestVersion++;

    clearInterval(listenerClock);

    for (const timer of audioTimers) {
      clearTimeout(timer);
    }
    audioTimers.clear();

    console.log('[CHAPTER 1 HANDOFF]', outcome);

    send({
      type: 'end',
      handoffData: outcome
    });
  }

    
    // THE LISTENER — CINEMATIC AUDIO DIRECTOR

    let lastCallerActivity = Date.now();
    let nextAmbientAt = Date.now() + 11000;
    let sceneBusyUntil = 0;
    let lastWrongVoiceAt = 0;

    const audioTimers = new Set();

    function markCallerActivity() {
      lastCallerActivity = Date.now();

      nextAmbientAt = Math.max(
        nextAmbientAt,
        Date.now() + 8500
      );
    }

    function scheduleAudio(delayMs, callback) {
      const timer = setTimeout(() => {
        audioTimers.delete(timer);

        if (!closed) callback();
      }, delayMs);

      audioTimers.add(timer);
    }

   
    function playListenerSound(name) {
      if (closed) return;

      const realSounds = [
        'knocks', 'roar', 'chain',
        'boom_a', 'boom_b'
      ];

      const extension = realSounds.includes(name)
        ? 'mp3'
        : 'wav';

      const source =
        `${PUBLIC_HTTPS_ORIGIN}/sfx/${name}.${extension}`;

      send({
        type: 'play',
        source,
        loop: 1,
        interruptible: true,
        preemptible: true
      });

      console.log('[LISTENER AUDIO]', name);
    }


    async function speakListenerLine(
      line,
      allowEnding = false
    ) {
      try {
        const source = await generateMarrowAudio(line);

        if (closed) return;

        if (
          !allowEnding &&
          director.snapshot().ending
        ) return;

        send({
          type: 'play',
          source,
          loop: 1,
          interruptible: true,
          preemptible: true
        });

      } catch (error) {
        console.error(
          '[LISTENER VOICE]',
          error.message
        );
      }
    }

    // THE LISTENER — REAL SOUND DIRECTOR

    const callStartedAt = Date.now();

    const scarePool = [
      'roar', 'chain', 'boom_a', 'boom_b'
    ];

    const soundLength = {
      knocks: 15000,
      roar: 6000,
      chain: 8000,
      boom_a: 4000,
      boom_b: 4000
    };

    let entrancePlayed = false;
    let lastScare = null;
    let activeSoundUntil = 0;
    let voiceUntil = 0;
    let firstHintGiven = false;

    function randomPause() {
      return 12000 +
        Math.floor(Math.random() * 13000);
    }

    function randomScare() {
      const choices = scarePool.filter(
        name => name !== lastScare
      );

      const choice = choices[
        Math.floor(Math.random() * choices.length)
      ];

      lastScare = choice;
      return choice;
    }

    const listenerClock = setInterval(() => {
      if (closed) return;

     
      const now = Date.now();
      const elapsed = now - callStartedAt;

      // CHAPTER 1 HARD STOP — Five minutes
      
      if (elapsed >= 300000) {
        finishChapter(
          director.snapshot().ending || 'expired'
        );
        return;
      }

       

      const events = director.tick();


      for (const outcome of events) {

        // DEATH EVENT
        if (outcome.effect === 'death') {
          sceneBusyUntil = now + 14000;
console.log(
  '[MARROW DEATH — ELAPSED SECONDS]',
  Math.round((Date.now() - callStartedAt) / 1000)
);
          playListenerSound('boom_a');
          activeSoundUntil = now + soundLength.boom_a;

          scheduleAudio(4200, () => {
            speakListenerLine(
              'NO! NO, GET OFF ME! HELP!',
              true
            );
          });

          // Let MARROW's final cry play,
          // then return the caller to Ruth.
          scheduleAudio(13500, () => {
            finishChapter('dead');
          });

          continue;
        }

        // INJURY EVENT
        if (outcome.effect === 'attack') {
          sceneBusyUntil = now + 13000;

          playListenerSound('boom_b');
          activeSoundUntil = now + soundLength.boom_b;

          scheduleAudio(4200, () => {
            speakListenerLine(
              'AAH! MY LEG! IT GOT MY LEG! ' +
              'I CAN BARELY MOVE!'
            );
          });

          continue;
        }

        // The old periodic knock effects are ignored.
        // Our new entrance and random sound pool
        // manage The Listener's presence.
      }

      if (director.snapshot().ending) return;

      // MARROW HELPS MOVE THE STORY FORWARD
      // instead of waiting silently forever.
      if (
        !firstHintGiven &&
        elapsed >= 25000 &&
        elapsed < 60000 &&
        now - lastCallerActivity >= 12000 &&
        now >= voiceUntil
      ) {
        firstHintGiven = true;

        speakListenerLine(
          'Hey! I can see a loose grate ' +
          'and some rusty pipes. ' +
          'Where do you want me to look first?'
        );

        return;
      }

      // GRAND ENTRANCE — PLAYS ONCE
      if (!entrancePlayed) {
        if (
          elapsed >= 65000 &&
          now >= sceneBusyUntil &&
          now >= voiceUntil &&
          now - lastCallerActivity >= 3000
        ) {
          entrancePlayed = true;

          playListenerSound('knocks');

          activeSoundUntil =
            now + soundLength.knocks;

          sceneBusyUntil = now + 21000;

          nextAmbientAt =
            now + soundLength.knocks + randomPause();

          scheduleAudio(15500, () => {
            speakListenerLine(
              'Oh, shit... did you hear that?! ' +
              'Three knocks. Whatever that is, ' +
              'it knows I am here.'
            );
          });
        }

        return;
      }

      // RANDOM SCARES AFTER THE GRAND ENTRANCE
      // Avoid interrupting important voice moments.
      if (
        now < sceneBusyUntil ||
        now < activeSoundUntil ||
        now < voiceUntil ||
        now < nextAmbientAt ||
        now - lastCallerActivity < 9000
      ) return;

      const name = randomScare();

      playListenerSound(name);

      activeSoundUntil =
        now + soundLength[name];

      nextAmbientAt =
        activeSoundUntil + randomPause();

    }, 1000);

   
    // Clean up when the caller hangs up.
    ws.once('close', () => {
      clearInterval(listenerClock);

      for (const timer of audioTimers) {
        clearTimeout(timer);
      }

      audioTimers.clear();
    });

    

  let requestVersion = 0;

  
  
  function send(message) {
    if (!closed && ws.readyState === WebSocket.OPEN) {

      // Protect MARROW's dialogue from random
      // monster effects while he's speaking.
      if (
        message.type === 'play' &&
        typeof message.source === 'string' &&
        message.source.includes('/audio/')
      ) {
        const hit =
          /\/audio\/([a-f0-9-]{36})\.mp3$/
            .exec(message.source);

        const cached = hit
          ? audioFiles.get(hit[1])
          : null;

        // ElevenLabs MP3 is generated at 32 kbps.
        // Estimate how long MARROW's line will play.
        const durationMs = cached
          ? cached.audio.length / 4
          : 7000;

        voiceUntil = Date.now() + Math.max(
          3500,
          Math.min(18000, durationMs + 600)
        );
      }

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

    // Once MARROW dies or escapes,
    // no new conversation can continue.
    if (director.snapshot().ending) {
      console.log(
        '[CHAPTER COMPLETE — INPUT IGNORED]',
        director.snapshot().ending
      );
      return;
    }

    let words = null;

    if (msg.type === 'prompt' && msg.last === true) {
      markCallerActivity();
      words = msg.voicePrompt;
    }

    // Keypad still works internally if needed.
   

if (msg.type === 'dtmf') {
  markCallerActivity();

  const result = director.press(msg.digit);

  if (!result.handled) return;

 
 

  if (result.effect === 'success') {
    requestVersion++;

    console.log(
      '[CHAPTER 1 VICTORY]',
      director.snapshot().room
    );

    playListenerSound('success');

    scheduleAudio(1500, async () => {
      await speakListenerLine(
        "WE DID IT! I'M OUTSIDE! OH MY GOD! " +
        "Listen, before that basement, I found a black card. " +
        "I called its number and helped a woman escape. " +
        "Then the line went dead. I woke up trapped down there. " +
        "Wait... why am I hearing those knocks out here?",
        true
      );

      const remainingMs = Math.max(
        1000,
        voiceUntil - Date.now() + 1200
      );

      scheduleAudio(remainingMs, () => {
        finishChapter('survived');
      });
    });

    return;
  }


  if (result.effect === 'green') {
    playListenerSound('green');
    return;
  }

  if (result.effect === 'red') {
    playListenerSound('red');

    // MARROW reacts, but not on every
    // rapid keypress.
    if (
      Date.now() - lastWrongVoiceAt > 7000
    ) {
      lastWrongVoiceAt = Date.now();

      scheduleAudio(550, () => {
        speakListenerLine(
          "SHIT! RED! START OVER!"
        );
      });
    }

    return;
  }
}

 
    // Ignore messages that are not completed speech.
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

        // CHAPTER 1 — MARROW'S SURVIVAL REFLEX
        const runCommand =
          !isNegative &&
          /\b(run|sprint|hurry|move)\b/.test(command);

        if (runCommand) {
          episode.stage = 'chasing';
          episode.danger = Math.min(10, episode.danger + 2);
        }

        // CHAPTER 1 — THE STAIRWELL ESCAPE
        const wantsStairwell =
          /\b(stairwell|stairs|exit door)\b/.test(command);

        const triesToEscape =
          !isNegative &&
          /\b(unlock|open|use|escape|try)\b/.test(command);

        
        // The Listener follows loud metallic sounds.
        const makesDistraction =
          !isNegative &&
          /\b(throw|toss|drop|bang|slam|rattle)\b/.test(command) &&
          /\b(metal|pipe|can|bottle|tool|scrap|wrench)\b/.test(command);

        if (
          !episode.ending &&
          episode.stage === 'stairwell_jammed' &&
          makesDistraction
        ) {
          episode.monsterLured = true;
          episode.stage = 'monster_distracted';
          episode.trust = Math.min(10, episode.trust + 1);
        }

        if (
          !episode.ending &&
          wantsStairwell &&
          triesToEscape &&
          ['chasing', 'stairwell_jammed',
           'monster_distracted', 'trapped_at_stairwell']
            .includes(episode.stage)
        ) {
          if (!episode.hasRedKey) {
            episode.stage = 'trapped_at_stairwell';
            episode.danger = Math.min(10, episode.danger + 3);
          } else if (episode.monsterLured) {
            episode.stage = 'escaped';
            episode.ending = 'survived';
          } else {
            episode.stage = 'stairwell_jammed';
            episode.danger = Math.min(10, episode.danger + 2);
          }
        }


        // MARROW MEMORY — Last 5 completed story moves

        // Once he escapes, don't let another
        // command send him back into the basement.
        if (episode.ending === 'survived') {
          episode.stage = 'escaped';
        }

        const locations = {
          basement: 'Flooded basement',
          key_collected: 'Basement maintenance area',
          hiding: 'Behind the rusty pipes',
          chasing: 'Flooded corridor',
          stairwell_jammed: 'Stairwell exit',
          trapped_at_stairwell: 'Locked stairwell',
          monster_distracted: 'Stairwell exit',
          escaped: 'Outside the building'
        };

        const moveDescriptions = {
          key_collected: 'Picked up the red key',
          hiding: 'Hid behind the rusty pipes',
          chasing: 'Ran into the flooded corridor',
          stairwell_jammed: 'Reached the jammed stairwell',
          trapped_at_stairwell: 'Failed to open the locked door',
          monster_distracted: 'Distracted The Listener',
          escaped: 'Escaped the basement and reached outside'
        };

        if (!episode.recentMoves) {
          episode.recentMoves = [
            'Started trapped in the flooded basement'
          ];
          episode.recordedState = 'basement|false|none';
        }

        const currentLocation =
          locations[episode.stage] || 'Unknown location';

        const stateSignature = [
          episode.stage,
          episode.hasRedKey,
          episode.ending || 'none'
        ].join('|');

        if (stateSignature !== episode.recordedState) {
          episode.recentMoves.push(
            moveDescriptions[episode.stage] ||
            `Reached ${currentLocation}`
          );

          episode.recentMoves =
            episode.recentMoves.slice(-5);

          episode.recordedState = stateSignature;
        }

        const recentMoveHistory =
          episode.recentMoves.join('\n');

        const liveInstructions = `${STORY_INSTRUCTIONS}

        CURRENT GAME STATE:
        Location/state: ${episode.stage}
        
        CURRENT PHYSICAL LOCATION: ${currentLocation}

        LAST FIVE COMPLETED STORY MOVES:
        ${recentMoveHistory}

        These are established events, not suggestions.
        Never forget completed movements.
        Never claim you are still in an earlier room.
        Objects left behind remain in their old locations.
        Only interact with objects physically accessible
        from your CURRENT location.
        Never rewind the story without a real reset.
        If you have escaped, stay outside.
        Do not invent new streets or missions.

        Has red maintenance key: ${episode.hasRedKey}
        Caller trust: ${episode.trust}
        
        Danger level: ${episode.danger}

        Chapter ending: ${episode.ending || 'none'}
        

        THE MONSTER — THE LISTENER:
        A tall, wet, distorted humanoid with a dragging
        foot and an unnaturally stretched face.
        Its signature is three knocks followed by scraping.
        It follows loud sounds and can mimic voices.
        Reveal its appearance gradually, never all at once.

        If stage is stairwell_jammed:
        The red key fits, but the heavy door is jammed.
        The Listener is approaching. Panic and resist
        reckless instructions. The caller must suggest
        making a loud metallic distraction elsewhere.

        If stage is monster_distracted:
        The metallic noise has drawn The Listener away.
        The stairwell door can now be opened with the key.
        Urgently ask the caller if you should try again.
        Do not claim you have escaped yet.

        If stage is escaped:
        The red key unlocked the stairwell.
        You made it outside alive!
        Celebrate wildly with the caller.
        Sound exhausted, relieved, emotional and grateful.
        Make the victory feel EARNED.
        Then notice something unsettling outside.

        If stage is trapped_at_stairwell:
        The door is locked and you cannot escape.
        Panic. You need the red maintenance key.
        Ask the caller what to do next.

        Never pretend you escaped unless
        the game state says escaped.

        When stage is chasing, you are being pursued
        through the flooded basement.

        React immediately and emotionally to the
        caller's instructions. Speak in short bursts.
        You are frightened, breathless and frustrated.

        If the caller screams RUN, respond like a
        terrified human being, not a calm narrator.

        You may argue, panic, or yell back.
        Do not magically escape or teleport.
        The chase is not over until a later
        story event resolves it.


        Respect the game state.
        Never claim to have the key when hasRedKey is false.
        Once collected, remember the key until a story event
        explicitly removes it.
        React emotionally to the caller's choices.
        `;



        // Ask the Director to process the caller's move.
        const directorEvent = director.act(input);


        // MARROW THINKS
        const response = await openai.responses.create({
          model: MODEL,
          
instructions: `${STORY_INSTRUCTIONS}

${director.context()}

LATEST DIRECTOR EVENT:
${directorEvent.handled
  ? directorEvent.text
  : 'No physical game action was completed.'}

IMPORTANT RULES:
The Director is the authority on physical reality.
React naturally and emotionally to its events.
Do not contradict the Director's current room.
Do not invent completed actions or discoveries.
Never reveal hidden clues or puzzle solutions.
Never invent an escape.
Keep your own personality, fear, humor and voice.
`,

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

       
if (
  closed ||
  myVersion !== requestVersion ||
  director.snapshot().ending
) {
  return;
}


        try {

          // MARROW SPEAKS WITH YOUR ELEVENLABS VOICE
          const mediaUrl = await generateMarrowAudio(reply);

         
if (
  closed ||
  myVersion !== requestVersion ||
  director.snapshot().ending
) {
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

         
          if (
            !closed &&
            myVersion === requestVersion &&
            !director.snapshot().ending &&
            !handoffSent
          ) {
            fallbackVoice(reply);
          }

        }

      } catch (error) {

        console.error(
          'AI request failed:',
          error.status || error.code || 'error'
        );

       
        if (
          !closed &&
          myVersion === requestVersion &&
          !director.snapshot().ending &&
          !handoffSent
        ) {
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
