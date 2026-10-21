
'use strict';

// THE LAST CALL — THE INVISIBLE DIRECTOR
// Chapter 1: MARROW vs. THE LISTENER

const CODE = '2846';

function createDirector({
  now = () => Date.now(),
  maxDurationMs = 330000,
  keypadDurationMs = 90000
} = {}) {

  const game = {
    started: now(),
    room: 'basement',
    keyFound: false,
    hasKey: false,
    injured: false,
    danger: 0,
    keypadStarted: null,
    codeProgress: 0,
    ending: null,
    clues: [],
    lastMoves: ['Woke up in the flooded basement'],
    lastTick: now()
  };

  const remember = move => {
    game.lastMoves.push(move);
    game.lastMoves = game.lastMoves.slice(-5);
  };

  const event = (text, effect = null) => ({
    handled: true,
    text,
    effect
  });

  const death = () => {
    game.ending = 'dead';
    game.room = 'dead';
    remember('The Listener killed MARROW');

    return event(
      'The Listener catches MARROW. He screams. Silence.',
      'death'
    );
  };

  const survival = () => {
    game.ending = 'survived';
    game.room = 'outside';
    remember('Unlocked the final door and escaped');

    return event(
      'The door opens! MARROW escapes outside. He survived!',
      'success'
    );
  };

  function tick() {
    if (game.ending) return [];

    const current = now();

    if (current - game.started >= maxDurationMs) {
      return [death()];
    }

    if (
      game.keypadStarted !== null &&
      current - game.keypadStarted >= keypadDurationMs
    ) {
      return [death()];
    }

    const elapsed = current - game.lastTick;

    if (elapsed >= 30000) {
      game.lastTick = current;
      game.danger = Math.min(10, game.danger + 1);

     if (
  game.danger >= 10 &&
  game.injured &&
  game.room !== 'keypad'
) {

      if (game.danger >= 4 && !game.injured) {
        game.injured = true;
        remember('The Listener injured MARROW');

        return [event(
          'A violent impact! MARROW falls. His leg is injured.',
          'attack'
        )];
      }

      return [event(
        'Three knocks. Metal scrapes across the floor.',
        'knocks'
      )];
    }

    return [];
  }

  function press(digit) {
    if (game.ending || game.room !== 'keypad') {
      return { handled: false };
    }

    digit = String(digit);

    if (digit === '*') {
      game.codeProgress = 0;
      return event('The keypad clears.', 'red');
    }

    if (!/^[0-9]$/.test(digit)) {
      return { handled: false };
    }

    if (digit === CODE[game.codeProgress]) {
      game.codeProgress++;

      if (game.codeProgress === 4) {
        return survival();
      }

      return event(
        `GREEN! ${game.codeProgress} lights are green.`,
        'green'
      );
    }

    game.codeProgress = 0;
    game.danger = Math.min(10, game.danger + 1);

    return event(
      'RED! All lights reset! The Listener heard that!',
      'red'
    );
  }

  function act(input) {
    if (!input || typeof input !== 'string') {
      return { handled: false };
    }

    const words = input.toLowerCase();

    if (game.ending) {
      return event(
        game.ending === 'survived'
          ? 'MARROW is outside. Chapter 1 is finished.'
          : 'MARROW is dead. A new attempt is required.'
      );
    }

    if (/\b(don't|dont|do not|never|stop)\b/.test(words)) {
      return { handled: false };
    }

    // Search basement for clues
    if (
      game.room === 'basement' &&
      /\b(search|look around|explore)\b/.test(words)
    ) {
      return event(
        'There are rusty pipes, a stopped clock, a loose grate, and a soaked note.'
      );
    }

    if (
      game.room === 'basement' &&
      /\b(note|paper)\b/.test(words)
    ) {
      if (!game.clues.includes('order')) {
        game.clues.push('order');
      }
      return event(
        'The note reads: Pipes. Clock. Switches. Door.'
      );
    }

    if (
      game.room === 'basement' &&
      /\b(pipes|pipe)\b/.test(words)
    ) {
      if (!game.clues.includes('2')) game.clues.push('2');
      return event('Two brass pipe couplings. TWO.');
    }

    if (
      game.room === 'basement' &&
      /\b(clock)\b/.test(words)
    ) {
      if (!game.clues.includes('8')) game.clues.push('8');
      return event('The clock is stopped at EIGHT.');
    }

    if (
      game.room === 'basement' &&
      /\b(grate|drain)\b/.test(words)
    ) {
      game.keyFound = true;
      return event('A red maintenance key is under the grate!');
    }

    if (/\b(grab|take|pick up|get)\b.*\bkey\b/.test(words)) {
      if (game.room !== 'basement') {
        return event('The key is back in the basement.');
      }

      if (!game.keyFound) {
        return event('He must find the key first.');
      }

      game.hasKey = true;
      remember('Picked up the red maintenance key');
      return event('MARROW grabs the red key!');
    }

    // Physical room transitions
    if (
      game.room === 'basement' &&
      /\b(go|move|run|walk|head)\b.*\b(corridor|hall)\b/.test(words)
    ) {
      game.room = 'corridor';
      remember('Left the basement for the corridor');
      return event('MARROW enters the corridor.');
    }

    if (
      game.room === 'corridor' &&
      /\b(switch|switches)\b/.test(words)
    ) {
      if (!game.clues.includes('4')) game.clues.push('4');
      return event('There are FOUR red wall switches.');
    }

    if (
      game.room === 'corridor' &&
      /\b(go|move|run|walk|head)\b.*\b(stairs|stairwell|exit)\b/.test(words)
    ) {
      game.room = 'stairwell';
      remember('Reached the locked stairwell');
      return event('MARROW reaches a locked steel door.');
    }

    if (
      game.room === 'stairwell' &&
      /\b(number|scratch|etch|inspect|look)\b/.test(words)
    ) {
      if (!game.clues.includes('6')) game.clues.push('6');
      return event('A SIX is scratched into the door.');
    }

    if (
      game.room === 'stairwell' &&
      /\b(open|unlock|use|turn)\b/.test(words)
    ) {
      if (!game.hasKey) {
        return event('MARROW needs the red key!');
      }

      game.room = 'keypad';
      game.keypadStarted = now();
      game.codeProgress = 0;
      remember('Used the red key to expose the keypad');

      return event(
        'Four keypad lights appear! The Listener is coming!',
        'knocks'
      );
    }

    // Keep MARROW physically consistent
    if (
      game.room !== 'basement' &&
      /\b(pipe|pipes)\b/.test(words)
    ) {
      return event(
        'Those pipes are back in the basement. MARROW is no longer there.'
      );
    }

    if (/\b(weapon|fight|attack)\b/.test(words)) {
      return event(
        'MARROW searches nearby. The Listener cannot be killed by an ordinary weapon.'
      );
    }

    if (/\b(run|sprint)\b/.test(words)) {
      game.danger = Math.min(10, game.danger + 2);

      return event(
        game.injured
          ? 'MARROW tries to run but his injured leg gives out!'
          : 'MARROW runs. The Listener hears his footsteps.'
      );
    }

    // Natural conversations remain with MARROW's AI.
    return { handled: false };
  }

  function context() {
    return [
      'AUTHORITATIVE STORY STATE:',
      `Current room: ${game.room}`,
      `Has red key: ${game.hasKey}`,
      `Leg injured: ${game.injured}`,
      `Danger: ${game.danger}/10`,
      `Keypad progress: ${game.codeProgress}/4`,
      `Ending: ${game.ending || 'none'}`,
      `Discovered clues: ${game.clues.join(', ')}`,
      'Last five moves:',
      ...game.lastMoves.map(m => '- ' + m),
      'Never contradict this state.',
      'Never teleport to an earlier room.',
      'Never invent an escape or weapon.',
      'The key opens the panel, not the exit.',
      'Only the correct phone keypad code opens the exit.',
      'Never reveal undiscovered clues or hidden timers.',
      'If MARROW dies he cannot continue talking.',
      'If he escapes Chapter 1 is complete.'
    ].join('\n');
  }

  function snapshot() {
    return {
      ...game,
      lastMoves: [...game.lastMoves],
      clues: [...game.clues]
    };
  }

  return { act, press, tick, context, snapshot };
}

module.exports = { createDirector };
