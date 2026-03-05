import {
  messageEvent, toolUseEvent, toolResultEvent,
  reasoningEvent, statusEvent, usageEvent,
} from '../normalizer.mjs';

/**
 * OpenCode adapter.
 *
 * When run with `opencode run --format json`, stdout emits JSONL events.
 *
 * Event types:
 * - step_start: Marks the beginning of a processing step
 * - tool_use: Tool invocation event (when completed)
 * - text: Text output from the model
 * - step_finish: End of a processing step
 * - error: Session error event
 */
export function createOpencodeAdapter() {
  // Accumulate text across multiple text events
  let accumulatedText = '';

  return {
    parseLine(line) {
      const trimmed = line.trim();
      if (!trimmed) return [];

      let obj;
      try {
        obj = JSON.parse(trimmed);
      } catch {
        // Not JSON, treat as plain text output
        if (trimmed) {
          return [messageEvent('assistant', trimmed)];
        }
        return [];
      }

      const events = [];
      const sessionId = obj.sessionID || '';

      switch (obj.type) {
        case 'step_start':
          events.push(statusEvent(
            `Step started${sessionId ? ` (session: ${sessionId})` : ''}`
          ));
          break;

        case 'tool_use': {
          // Tool invocation completed
          const tool = obj.part?.tool || 'unknown';
          const input = obj.part?.state?.input || {};
          const output = obj.part?.state?.output || '';
          const title = obj.part?.state?.title || '';

          // Emit tool use event
          const inputStr = typeof input === 'string'
            ? input
            : JSON.stringify(input, null, 2);
          events.push(toolUseEvent(tool, inputStr));

          // Emit tool result if there's output
          if (output) {
            events.push(toolResultEvent(tool, output));
          } else if (title) {
            // Use title as result description
            events.push(toolResultEvent(tool, title));
          }
          break;
        }

        case 'text': {
          // Text output from model - accumulate it
          const text = obj.part?.text || '';
          accumulatedText += text;
          break;
        }

        case 'step_finish': {
          // End of step - emit accumulated text if any
          if (accumulatedText) {
            events.push(messageEvent('assistant', accumulatedText));
            accumulatedText = '';
          }

          const reason = obj.part?.reason;
          const cost = obj.part?.cost;
          const tokens = obj.part?.tokens || {};

          // Emit usage if available
          if (tokens.input !== undefined || tokens.output !== undefined) {
            events.push(usageEvent(
              tokens.input || 0,
              tokens.output || 0,
              tokens.reasoning || 0
            ));
          }

          // Emit completion status
          if (reason === 'stop') {
            events.push(statusEvent('completed'));
          } else if (reason === 'tool-calls') {
            events.push(statusEvent('waiting for tool results...'));
          }
          break;
        }

        case 'error': {
          const errorName = obj.error?.name || 'UnknownError';
          const errorMsg = obj.error?.data?.message || 'An error occurred';
          events.push(statusEvent(`error: ${errorName} - ${errorMsg}`));
          events.push(statusEvent('completed'));
          break;
        }

        default:
          break;
      }

      return events;
    },

    flush() {
      // Emit any remaining accumulated text
      const events = [];
      if (accumulatedText) {
        events.push(messageEvent('assistant', accumulatedText));
        accumulatedText = '';
      }
      return events;
    },
  };
}

/**
 * Build the command-line arguments for spawning OpenCode.
 */
export function buildOpencodeArgs(prompt, options = {}) {
  const args = ['run', '--format', 'json'];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.agent) {
    args.push('--agent', options.agent);
  }

  if (options.session) {
    args.push('--session', options.session);
  } else if (options.continue) {
    args.push('--continue');
  }

  if (Array.isArray(options.images)) {
    for (const img of options.images) {
      const path = img.savedPath || img.path;
      if (path) args.push('--file', path);
    }
  }

  if (prompt) {
    args.push(prompt);
  }

  return args;
}
