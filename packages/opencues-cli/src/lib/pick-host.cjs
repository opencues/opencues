// lib/pick-host.cjs — shared interactive host picker for install / uninstall /
// run. Each of those commands errors on a missing <host>; on a terminal they
// call this instead to select from their own host list.

'use strict';

const prompt = require('./prompt.cjs');
const { dim } = require('./style.cjs');

/**
 * @param {string[]} hosts   the command's host list
 * @param {object}   opts    { verb?: string, allowAll?: boolean }
 * @returns {Promise<string|null>} chosen host, '--all', or null on cancel
 */
async function pickHost(hosts, opts = {}) {
  const choices = hosts.map(h => ({ label: h, value: h }));
  if (opts.allowAll) choices.push({ label: `all  ${dim('(every integration)')}`, value: '--all' });
  choices.push({ spacer: true });
  choices.push({ label: 'Cancel', value: null, dim: true });
  console.log(dim(`${opts.verb || 'Which host'}?  ·  ↑↓ move · Enter select`));
  return prompt.select('', choices);
}

module.exports = { pickHost };
