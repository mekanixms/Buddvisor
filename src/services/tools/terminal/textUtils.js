/**
 * Text helpers for terminal output: strip escape codes, normalize line endings,
 * and shrink long output to a size the model can afford.
 */

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g;
const CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/**
 * Remove ANSI sequences and control characters; keep only the final state of
 * lines rewritten with carriage returns (progress bars).
 */
function cleanTerminalText(text) {
  const withoutAnsi = String(text).replace(ANSI_PATTERN, '').replace(/\r\n/g, '\n');
  const lines = withoutAnsi.split('\n').map((line) => {
    const trimmed = line.replace(/\r+$/, '');
    const lastReturn = trimmed.lastIndexOf('\r');
    return lastReturn === -1 ? trimmed : trimmed.slice(lastReturn + 1);
  });
  return lines.join('\n').replace(CONTROL_PATTERN, '');
}

/** Drop leading blank lines and trailing whitespace. */
function trimBlock(text) {
  return text.replace(/^(?:[ \t]*\n)+/, '').replace(/\s+$/, '');
}

/**
 * Keep the start and (mostly) the end of long text; errors and results are
 * usually at the end.
 * @returns {{text: string, omitted: number}}
 */
function truncateMiddle(text, maxChars) {
  if (text.length <= maxChars) return { text, omitted: 0 };
  const headLength = Math.floor(maxChars * 0.25);
  const tailLength = maxChars - headLength;
  const omitted = text.length - headLength - tailLength;
  return {
    text: `${text.slice(0, headLength)}\n...[${omitted} chars omitted]...\n${text.slice(text.length - tailLength)}`,
    omitted,
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function findLongLine(text, maxChars) {
  return String(text).split('\n').findIndex((line) => line.length > maxChars);
}

module.exports = {
  cleanTerminalText,
  trimBlock,
  truncateMiddle,
  shellQuote,
  findLongLine,
};
