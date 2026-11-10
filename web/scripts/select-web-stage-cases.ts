import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { catalog, profileNumbers, shuffle } from '../src/ts/scheduler/plan.ts';
import { ROOT } from '../src/ts/scheduler/io.ts';

const seed = 2026;
const category = 'web_search_no_snippet';
const main = catalog().map(task => String(task.id)).sort((left, right) => numberOf(left) - numberOf(right));
const profile = profileNumbers.map(number => category + '_' + number);
if (main.length !== 100 || main.some((id, number) => id !== category + '_' + number) ||
    profile.length !== 12 || new Set(profile).size !== 12 || profile.some(id => !main.includes(id))) {
  throw new Error('Unexpected Web catalog or profile set');
}

const remaining = shuffle(main.filter(id => !profile.includes(id)), String(seed));
const pilot = remaining.slice(0, 8);
const slice = remaining.slice(8, 28);

function numberOf(id: string): number {
  return Number(id.split('_').at(-1));
}

function writeTemplate(name: string, ids: string[]) {
  const file = join(ROOT, 'config/stages', name + '.json');
  const original = readFileSync(file, 'utf8');
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const selections = /"caseIds": (?:\[[^\]]*\]|"all"|"profile")/g;
  const expectedSelections = name.includes('slice') ? 2 : 1;
  if ([...original.matchAll(selections)].length !== expectedSelections) throw new Error('Unexpected batches: ' + name);
  const selection = '"caseIds": [' + eol + ids.map(id => '        ' + JSON.stringify(id)).join(',' + eol) + eol + '      ]';
  const updated = original.replace(selections, selection)
    .replace(/"seed": \d+/, '"seed": ' + seed)
    .replace(/"rounds": \d+/, '"rounds": 1')
    .replace(/"targetedSplit": "[^"]+"/, '"targetedSplit": "TARGETED_SPLIT_REQUIRED.json"');
  // A pending Web tag has no frozen image yet, including the older T8c templates.
  const pendingImage = updated.includes('"tag": "test-web-pending"')
    ? updated.replace(/^[ \t]+"imageId": "sha256:[a-f0-9]{64}",\r?\n/m, '')
      .replace(/,\r?\n[ \t]+"imageId": "sha256:[a-f0-9]{64}"(?=\r?\n)/, '')
    : updated;
  if (pendingImage !== original) writeFileSync(file, pendingImage);
}

const options = process.argv.slice(2);
if (options.length === 1 && options[0] === '--write') {
  for (const prefix of ['', 'live-']) {
    writeTemplate(prefix + 'profile', profile);
    writeTemplate(prefix + 'pilot', pilot);
    writeTemplate(prefix + 'slice', slice);
    writeTemplate(prefix + 'main', main);
  }
  writeTemplate('t8c-integration', pilot);
  writeTemplate('t8c-slice-exp1-v1', slice);
  writeTemplate('t8c-slice-exp1-v2', slice);
} else if (options.length) {
  throw new Error('Usage: select-web-stage-cases.ts [--write]');
}
console.log(JSON.stringify({seed, profile, pilot, slice, main}, null, 2));
