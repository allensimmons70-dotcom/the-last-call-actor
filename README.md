# The Last Call — first AI actor

This is the **first prototype**, not a public release. It connects Twilio Studio's
Conversation Relay widget to OpenAI so the caller can speak and get an improvised
reply in a believable horror scene. It is not a finished game or persistent account system.

## Before anything else

- Keep Ruth's existing welcome, 18+ confirmation, and exit branch in Twilio Studio.
- Sign up for OpenAI **API** access at https://platform.openai.com/ (separate from ChatGPT subscription).
- Keep API credentials in environment variables, **not in GitHub**.
- Accept Twilio's Voice Predictive and Generative AI/ML Features Addendum if prompted.
- Twilio, OpenAI API, and hosting costs apply. Set spending limits/alerts before testing.

## Deploy on Render (a paid always-on instance is best for reliable phone testing)

1. Create a private GitHub repository, e.g. `the-last-call-actor`.
2. Upload `server.js`, `package.json`, `.gitignore`, and `README.md` from this folder.
3. Go to https://dashboard.render.com/ → **New > Web Service** → select that repo.
4. Runtime: Node; Build command: `npm install`; Start command: `npm start`.
5. Choose a suitable instance type. Free instances may sleep, introducing a long delay for an incoming call.
6. After Render provides a URL such as `https://my-last-call.onrender.com`, set these **Environment** variables:

   - `PUBLIC_WSS_URL` = `wss://my-last-call.onrender.com/ws`
   - `OPENAI_API_KEY` = your OpenAI API key (secret)
   - `TWILIO_AUTH_TOKEN` = Twilio account auth token (secret)
   - `OPENAI_MODEL` = `gpt-4.1-mini`

7. Redeploy. Visit `https://my-last-call.onrender.com/health` in a browser. It should return `status: ok`.

## In Twilio Studio

1. Open your existing **The Last Call** flow.
2. Find **Conversation Relay** in the widget list. Do not delete Ruth or `gather_1` or `split_1`.
3. Connect `say_play_2` **Audio Complete** to **Conversation Relay**. Press 2 still goes to exit.
4. Set **WebSocket URL** to the `PUBLIC_WSS_URL` exactly, including `wss://` and `/ws`.
5. Set **Welcome Greeting** to: `Hello? Who's there? Wait. I need your help. There's something outside this door. Can you hear me?`
6. For the first test, select one of the supported English voices. We can make it more cinematic later.
7. Connect the Conversation Relay **Failed** transition to an apologetic Say/Play fallback, not straight into another loop.
8. Save and Publish the Studio flow. Make a private test call and press 1.

### What it can do NOW

- A fictional male actor reacts to ordinary speech and responds conversationally.
- The AI improvises around the red key or hiding decision and remembers the current call's conversation.
- Pressing 1 or 2 *during the conversation*, when Twilio emits DTMF, is supported by the server.
- Does not store caller numbers, names, or transcripts across calls.

### What it does NOT do YET

- Persistent player ID, squad lobbies, chapter purchases, secure opt-in outbound calls, voice biometrics.
- Cinematic recorded audio effects, perfect low-latency barge-in, or tested production reliability.
- Guaranteed 18+ verification beyond Ruth's self-declared press-1 gate.

## Security / privacy

WebSocket requests are verified with Twilio's `X-Twilio-Signature` and the private auth token.
The app accepts only signed connections. No full transcripts or phone numbers are intentionally logged by the app.
The OpenAI request uses `store:false` and short per-call context. Twilio/platform-side processing and logs
are separate and require a proper privacy disclosure before public use.

Do not share your Twilio auth token, OpenAI API key, or screenshot of those values.
