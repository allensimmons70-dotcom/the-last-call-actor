
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

const {
  createPlayerMemoryStore,
  normalizePhone,
  extractNickname,
  memoryCommand
} = require('./player-memory');


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

//
// THE LAST CALL — PLAYER MEMORY SYSTEM
//

let memoryStore = null;
let memoryReady = Promise.resolve(false);

try {
  memoryStore = createPlayerMemoryStore({
    enabled: process.env.PLAYER_MEMORY_ENABLED === 'true',
    databaseUrl: process.env.DATABASE_URL,
    hashSecret: process.env.PLAYER_HASH_SECRET,
    
    ssl: process.env.PLAYER_DB_SSL === 'true',
    schema: process.env.PLAYER_MEMORY_SCHEMA || 'public'
  });


  if (memoryStore) {
    memoryReady = memoryStore.init()
      .then(() => {
        console.log('[PLAYER MEMORY] Database ready');
        return true;
      })
      .catch((error) => {
        console.error(
          '[PLAYER MEMORY DATABASE]',
          error.message
        );
        return false;
      });
  }

} catch (error) {
  console.error(
    '[PLAYER MEMORY CONFIG]',
    error.message
  );
}

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
  maxDurationMs: 305000,
  keypadDurationMs: 90000
});



  let pending = Promise.resolve();
  let closed = false;
  
  let handoffSent = false;

  // THE LAST CALL — CURRENT PLAYER
  const player = {
    phone: null,
    callSid: null,
    runKey: null,
    nickname: null,
    optedIn: false,
    previous: null,
    dbReady: false,
    resumeConfirmed: false,
  };

  let setupTask = Promise.resolve();
  let memoryWrites = Promise.resolve();

  // THE LAST CALL — MEMORY SAVE QUEUE
  function queueMemoryWrite(task) {
    const next = memoryWrites.then(task);

    memoryWrites = next.catch(error => {
      console.error('[PLAYER MEMORY WRITE]', error.message);
    });

    return next;
  }

  function savePlayerProgress(outcome = null) {
    if (
      !player.optedIn ||
      !player.dbReady ||
      !player.phone ||
      !player.runKey
    ) {
      return Promise.resolve(false);
    }

    return queueMemoryWrite(() => memoryStore.save({
      phone: player.phone,
      callSid: player.callSid,
      runKey: player.runKey,
      nickname: player.nickname,
      outcome: outcome,
      snapshot: director.snapshot()
    }));
  }

  // Speak memory responses using MARROW'S ElevenLabs voice.
  async function sayMemoryLine(words) {
    try {
      const source = await generateMarrowAudio(words);

      if (!closed && !handoffSent) {
        send({
          type: 'play',
          source,
          loop: 1,
          interruptible: true,
          preemptible: true
        });
      }
    } catch (error) {
      console.error('[PLAYER MEMORY VOICE]', error.message);

      if (!closed && !handoffSent) {
        fallbackVoice(words);
      }
    }
  }

 
  // THE LAST CALL — SAVE FINAL OUTCOME
  // Then return the caller to Ruth.

  async function finishChapter(outcome) {
    if (closed || handoffSent) return;

    handoffSent = true;
    requestVersion++;

    clearInterval(listenerClock);

    for (const timer of audioTimers) {
      clearTimeout(timer);
    }
    audioTimers.clear();

    const finalOutcome =
      ['survived', 'dead', 'expired'].includes(outcome)
        ? outcome
        : 'expired';

    console.log('[CHAPTER 1 HANDOFF]', finalOutcome);

    // Save only when the player opted in.
    // Never keep Ruth waiting indefinitely.
    if (
      player.optedIn &&
      player.dbReady &&
      player.phone &&
      player.runKey
    ) {
      let saveTimer;

      try {
        const timeout = new Promise(resolve => {
          saveTimer = setTimeout(
            () => resolve('timeout'),
            1500
          );
        });

        const result = await Promise.race([
          savePlayerProgress(finalOutcome),
          timeout
        ]);

        if (result === 'timeout') {
          console.warn('[MEMORY] Ending save timed out');
        } else {
          console.log(
            '[MEMORY] Ending save completed'
          );
        }

      } catch (error) {
        console.error(
          '[MEMORY ENDING SAVE]',
          error.message
        );

      } finally {
        clearTimeout(saveTimer);
      }
    }

    // Return to Ruth even if saving failed.
    if (!closed) {
      send({
        type: 'end',
        handoffData: finalOutcome
      });
    }
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

   
  function playListenerSound(name, protect = false) {
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
        interruptible: !protect,
preemptible: !protect
      });

      console.log('[LISTENER AUDIO]', name);
    }

    async function speakListenerLine(
  line,
  allowEnding = false,
  lockScene = false
)
     {
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
   let lastScenePromptAt = 0;
    let openingClueBeatPlayed = false;
  let keyBeatPlayed = false;
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

        
        // THE LISTENER — SCRIPTED ATTACK
        if (outcome.effect === 'attack') {

          console.log('[DIRECTOR] LISTENER ATTACK');

          // Reserve this scene for cinematic audio.
          sceneBusyUntil = now + 21000;

          // 1. THE LISTENER ROARS
         playListenerSound('roar', true);
          activeSoundUntil = now + soundLength.roar;

          // 2. THE LISTENER STRIKES MARROW
          scheduleAudio(6200, () => {
            if (director.snapshot().ending) return;

            playListenerSound('boom_b');

            activeSoundUntil =
              Date.now() + soundLength.boom_b;
          });

          // 3. MARROW REACTS TO THE INJURY
          scheduleAudio(10500, () => {
            if (director.snapshot().ending) return;

            speakListenerLine(
              "AAAHHH! FUCK! MY LEG! " +
              "IT GOT MY LEG! " +
              "I CAN BARELY STAND! " +
              "WE HAVE TO GET OUT OF HERE!"
            );
          });

          // Don't launch another random scare
          // immediately after the attack.
          nextAmbientAt =
            now + 21000 + randomPause();

          continue;
        }


        // The old periodic knock effects are ignored.
        // Our new entrance and random sound pool
        // manage The Listener's presence.
      }

      if (director.snapshot().ending) return;
      
      
      // DIRECTOR BEAT 1 — THE SOAKED NOTE
      // MARROW actively begins the investigation.

      const beatState = director.snapshot();

      if (
        !openingClueBeatPlayed &&
        elapsed >= 20000 &&
        beatState.room === 'basement' &&
        !beatState.clues.includes('order') &&
        now >= sceneBusyUntil &&
        now >= activeSoundUntil &&
        now >= voiceUntil &&
        now - lastCallerActivity >= 2500
      ) {
        const noteEvent =
          director.act('read the soaked note');

        if (noteEvent.handled) {
          openingClueBeatPlayed = true;
          lastScenePromptAt = now;
          sceneBusyUntil = now + 8000;

          console.log(
            '[DIRECTOR] First clue discovered'
          );

          speakListenerLine(
            "WAIT! There's a note stuck to " +
            "these rusty pipes! " +
            "Pipes. Clock. Switches. Door. " +
            "What the hell does that mean?! " +
           "Help me figure this out!",
false,
true
);

          return;
        }
      }


      // DIRECTOR BEAT 2 — THE RED KEY
      // Keep the adventure moving.

      const keyState = director.snapshot();

      if (
        !keyBeatPlayed &&
        elapsed >= 90000 &&
        keyState.room === 'basement' &&
        !keyState.hasKey &&
        now >= sceneBusyUntil &&
        now >= activeSoundUntil &&
        now >= voiceUntil &&
        now - lastCallerActivity >= 2500
      ) {
        // Discover the key if not already found.
        if (!keyState.keyFound) {
          director.act('look under the grate');
        }

        // Physically collect the key.
        director.act('grab the red key');

        const updated = director.snapshot();

        if (updated.hasKey) {
          keyBeatPlayed = true;
          lastScenePromptAt = now;
          sceneBusyUntil = now + 9000;

          console.log(
            '[DIRECTOR BEAT 2] RED KEY COLLECTED'
          );

          speakListenerLine(
            "WAIT! There's something under " +
            "this grate! A RED KEY! " +
            "I GOT IT! I GOT THE DAMN KEY! " +
            "There's a corridor ahead. " +
            "We gotta move! Which way?!"
          );

          return;
        }
      }

      // DIRECTOR BEAT 3 — THE CORRIDOR
      // MARROW moves when the caller hesitates.

      const corridorState = director.snapshot();

      if (
        elapsed >= 102000 &&
        corridorState.room === 'basement' &&
        corridorState.hasKey &&
        now >= sceneBusyUntil &&
        now >= activeSoundUntil &&
        now >= voiceUntil &&
        now - lastCallerActivity >= 2000
      ) {
        const move = director.act('go to the corridor');

        if (
          move.handled &&
          director.snapshot().room === 'corridor'
        ) {
          lastScenePromptAt = now;
          sceneBusyUntil = now + 7500;

          console.log(
            '[DIRECTOR BEAT 3] ENTERED CORRIDOR'
          );

          speakListenerLine(
            "I'm moving! I'm out of that room! " +
            "There's a row of red switches on the wall " +
            "and a stairwell ahead. " +
            "What do I check?!"
          );

          return;
        }
      }

      
      // CHAPTER 1 — MARROW TAKES INITIATIVE
      // Physical actions still belong to the Director.

      const scene = director.snapshot();

      if (
        elapsed >= 20000 &&
        elapsed < 265000 &&
        (elapsed < 65000 || entrancePlayed) &&
        now - lastCallerActivity >= 11000 &&
        now - lastScenePromptAt >= 24000 &&
        now >= activeSoundUntil &&
        now >= sceneBusyUntil &&
        now >= voiceUntil &&
        !handoffSent
      ) {
        let line = null;

        if (scene.room === 'basement') {
          line = !scene.keyFound
            ? "There's a loose grate and a soaked note here. Which one should I examine?"
            : !scene.hasKey
              ? "I can see a red key under the grate. Should I grab it?"
              : "I've got the red key in my hand. There's a corridor ahead. Should I move?";

        } else if (scene.room === 'corridor') {
          line =
            "I'm in the corridor. Four red switches, and the stairwell ahead. What do you want me to check?";

        } else if (scene.room === 'stairwell') {
          line = scene.hasKey
            ? "I'm at the steel exit. The key's still in my hand, and there's a red panel beside the door. Use it?"
            : "The exit panel needs a key. I left that loose grate behind in the basement. What now?";

        } else if (scene.room === 'keypad') {
          line =
            "Four lights on the keypad! Use your REAL phone keypad! Remember the clues! Hurry!";
        }

        if (line) {
          lastScenePromptAt = now;
          speakListenerLine(line);
          return;
        }
      }


      // GRAND ENTRANCE — PLAYS ONCE
      if (!entrancePlayed) {
        if (
          elapsed >= 65000 &&
          now >= sceneBusyUntil &&
         now >= voiceUntil &&
now >= activeSoundUntil
        ) {
          entrancePlayed = true;

         playListenerSound('knocks', true);

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
  console.log('[MARROW] Caller connected');

  player.phone = normalizePhone(msg.from);
  player.callSid =
    typeof msg.callSid === 'string'
      ? msg.callSid
      : null;

  setupTask = (async () => {
    player.dbReady = await memoryReady;

    if (player.dbReady && player.phone) {
      player.runKey = memoryStore.runKeyFor(
        player.callSid,
        player.phone
      );

      try {
        player.previous = await memoryStore.load(
          player.phone
        );

        if (player.previous) {
          player.optedIn = true;
          player.nickname = player.previous.nickname;
          console.log('[MEMORY] Returning player found');
        }

      } catch (error) {
        player.dbReady = false;
        console.error(
          '[MEMORY LOOKUP]',
          error.message
        );
      }
    }

    const intro = player.previous
      ? (
        "Hello? HELLO?! Wait... " +
        "I think this number has called before. " +
        "Is that you again? " +
        "I'm trapped down here, and something " +
        "is outside this door. Can you help me?"
      )
      : (
        "Hello? HELLO?! Oh, thank God, " +
        "somebody answered. Listen, I don't " +
        "know who you are, but I'm trapped " +
        "down here. There's something outside " +
        "this door... and I think it knows " +
        "I'm here. Can you help me?"
      );

    const introVersion = requestVersion;

    try {
      const mediaUrl = await generateMarrowAudio(intro);

      if (
        closed ||
        handoffSent ||
        requestVersion !== introVersion
      ) return;

      send({
        type: 'play',
        source: mediaUrl,
        loop: 1,
        interruptible: true,
        preemptible: true
      });

    } catch (error) {
      console.error(
        '[MARROW INTRO]',
        error.message
      );

      if (
        !closed &&
        !handoffSent &&
        requestVersion === introVersion
      ) {
        fallbackVoice(intro);
      }
    }
  })();

  setupTask.catch(error => {
    console.error('[MEMORY SETUP]', error.message);
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
      director.snapshot().location
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
 await setupTask;
      if (closed) return;

      // THE LAST CALL — MEMORY VOICE COMMANDS

      // RETURNING PLAYER — CONFIRM BEFORE RECALL
      if (player.previous && !player.resumeConfirmed) {
        const answer = input.trim()
          .toLowerCase()
          .replace(/[.!?]+$/, '');

        if (memoryCommand(input) === 'forget') {
          player.optedIn = false;
          player.previous = null;
          player.nickname = null;

          try {
            await queueMemoryWrite(() =>
              memoryStore.forget(player.phone)
            );
            await sayMemoryLine(
              "Okay. Your saved story is erased."
            );
          } catch (error) {
            console.error('[MEMORY DELETE]', error.message);
            await sayMemoryLine(
              "I couldn't confirm the deletion."
            );
          }
          return;
        }

        if (/^(continue|resume|yes|yeah|yep|it's me|it is me)$/.test(answer)) {
          player.resumeConfirmed = true;
          await sayMemoryLine(
            "Okay... let's pick up where we left off."
          );
          return;
        }

        if (/^(new game|start over|no|nope)$/.test(answer)) {
          player.previous = null;
          player.nickname = null;
          player.optedIn = false;

          await sayMemoryLine(
            "All right. Fresh start. Help me get out of here!"
          );
          return;
        }

        await sayMemoryLine(
          "Before we continue, do you want to resume " +
          "your saved story? Say continue or new game."
        );
        return;
      }

      const statedName = extractNickname(input);

      if (statedName) {
        player.nickname = statedName;

        if (player.optedIn) {
          savePlayerProgress(null).catch(error => {
            console.error('[MEMORY NAME]', error.message);
          });
        }
      }

      const command = memoryCommand(input);

      // FORGET ME — erase saved history
      if (command === 'forget') {
        player.optedIn = false;
        player.previous = null;
        player.nickname = null;

        try {
          if (player.dbReady && player.phone) {
            await queueMemoryWrite(() =>
              memoryStore.forget(player.phone)
            );

            await sayMemoryLine(
              "Okay. I've erased your saved story. " +
              "This call won't be remembered."
            );
          } else {
            await sayMemoryLine(
              "I won't save this call, but I can't " +
              "access the records to confirm deletion."
            );
          }
        } catch (error) {
          console.error('[MEMORY DELETE]', error.message);

          await sayMemoryLine(
            "I couldn't confirm the deletion. " +
            "Please try again later."
          );
        }

        return;
      }

      // REMEMBER ME — save progress with consent
      if (command === 'remember') {
        if (
          !player.dbReady ||
          !player.phone ||
          !player.runKey
        ) {
          await sayMemoryLine(
            "I can't save your progress right now. " +
            "But I'm still here. Don't hang up!"
          );
          return;
        }

        try {
          player.optedIn = true;

          const saved = await savePlayerProgress(null);
          if (!saved) {
            throw new Error('Memory save unavailable');
          }

          await sayMemoryLine(
            "Okay. I'll remember you. " +
            "Next time you call from this number, " +
            "I'll know what happened down here. " +
            "Say forget me anytime to erase it."
          );

        } catch (error) {
          player.optedIn = false;

          console.error('[MEMORY SAVE]', error.message);

          await sayMemoryLine(
            "Something went wrong. " +
            "I couldn't save our progress."
          );
        }

        return;
      }

      history.push({
        role: 'user',
        content: input
      });

      try {
        
        
        // Ask the Director to process the caller's move.
        const directorEvent = director.act(input);

// SPOKEN KEYPAD VICTORY
// Same ending as a successful phone keypad entry.

if (directorEvent.effect === 'success') {
  requestVersion++;

  playListenerSound('success');

  scheduleAudio(1500, async () => {
    await speakListenerLine(
      "WE DID IT! I'M OUTSIDE! OH MY GOD! " +
      "Listen, before that basement, " +
      "I found a black card. " +
      "I called its number and helped a woman escape. " +
      "Then the line went dead. " +
      "I woke up trapped down there. " +
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

        // MARROW THINKS — MEMORY-AWARE DIALOGUE

        const memoryContext =
          player.optedIn &&
          player.previous &&
          player.resumeConfirmed
            ? [
                'This caller confirmed their saved story.',
                'Saved nickname: ' +
                  (player.nickname || 'not supplied'),
                'Previous outcome: ' +
                  (player.previous.lastOutcome || 'unfinished'),
                'Previous story decisions: ' +
                  (
                    Array.isArray(
                      player.previous.lastSnapshot?.recentMoves
                    )
                      ? player.previous.lastSnapshot.recentMoves
                          .slice(-3).join('; ')
                      : 'none stored'
                  )
              ].join('\n')
            : 'No confirmed saved history. ' +
              'Never invent previous calls.';

        const response = await openai.responses.create({
          model: MODEL,

          instructions: [
            STORY_INSTRUCTIONS,
            director.context(),

            'RETURNING PLAYER MEMORY:\n' +
              memoryContext,

            'MEMORY RULES:\n' +
              'Only reference previous calls after ' +
              'the caller confirms they want to resume. ' +
              'Never claim to recognize their voice. ' +
              'Previous inventory and puzzles do not ' +
              'carry into a new attempt.',

            'LATEST DIRECTOR EVENT:\n' +
              (
                directorEvent.handled
                  ? directorEvent.text
                  : 'No physical game action was completed.'
              ),

            'IMPORTANT RULES:\n' +
              'The Director controls physical reality. ' +
              'React naturally and emotionally. ' +
              'Do not contradict the current room. ' +
              'Never invent completed actions, ' +
              'hidden clues, or an escape. ' +
              'Stay frightened, funny, and human.'
          ].join('\n\n'),

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
