/**
 * Raw keyboard passthrough.
 *
 * Ink's own `useInput` decodes keypresses into a friendly shape, which is exactly
 * wrong here: the child needs the original bytes, escape sequences and all. So we
 * take stdin ourselves and forward it verbatim.
 *
 * App-level shortcuts live behind a leader key (tmux-style) rather than plain
 * chords. That guarantees the wrapper can never shadow a binding inside `claude` —
 * every key except the leader itself reaches the child untouched.
 */

import { useEffect, useRef } from 'react';
import { useStdin } from 'ink';
import { StringDecoder } from 'node:string_decoder';

export interface RawInputOptions {
  /** Byte that begins an app command, e.g. '\x07' for Ctrl+G. */
  leader: string;
  /** Receives everything destined for the child. */
  onData: (data: string) => void;
  /** Receives the single character typed after the leader. */
  onCommand: (key: string) => void;
  enabled?: boolean;
}

export function useRawInput({
  leader,
  onData,
  onCommand,
  enabled = true,
}: RawInputOptions): void {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();

  // Held in refs so a re-created callback doesn't tear down and re-attach the
  // stdin listener mid-keystroke, which would drop the leader-pending state.
  const onDataRef = useRef(onData);
  const onCommandRef = useRef(onCommand);
  onDataRef.current = onData;
  onCommandRef.current = onCommand;

  const leaderPending = useRef(false);

  useEffect(() => {
    if (!enabled || !isRawModeSupported) return;

    setRawMode(true);

    // Raw mode delivers Buffers, and a pasted multi-byte character can straddle
    // two chunks. StringDecoder holds the partial sequence instead of emitting
    // replacement characters into the child's input.
    const decoder = new StringDecoder('utf8');

    const handle = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      if (text.length === 0) return;

      let passthrough = '';

      for (const char of text) {
        if (leaderPending.current) {
          leaderPending.current = false;
          // Leader twice sends a literal leader through, so the key is never
          // permanently stolen from the child.
          if (char === leader) {
            passthrough += leader;
            continue;
          }
          if (passthrough.length > 0) {
            onDataRef.current(passthrough);
            passthrough = '';
          }
          onCommandRef.current(char);
          continue;
        }

        if (char === leader) {
          leaderPending.current = true;
          continue;
        }

        passthrough += char;
      }

      if (passthrough.length > 0) onDataRef.current(passthrough);
    };

    stdin.on('data', handle);

    return () => {
      stdin.off('data', handle);
      setRawMode(false);
      leaderPending.current = false;
    };
  }, [stdin, setRawMode, isRawModeSupported, leader, enabled]);
}
