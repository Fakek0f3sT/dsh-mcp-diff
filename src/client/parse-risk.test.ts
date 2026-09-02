/**
 * Self-check for the risk-annotation detector. Run with tsx:
 *   node --import tsx src/client/parse-risk.test.ts
 * Prints `parse-risk self-check ok` and exits 0, or names the failing case.
 */
import { riskTags } from './parse-risk'

let failed = 0

function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failed++
    console.error(`FAIL ${name}\n  expected: ${e}\n  actual:   ${a}`)
  }
}

// Hits.
check('rm -rf', riskTags(`rm -rf build`), ['rm -rf'])
check('rm -fr', riskTags(`rm -fr build`), ['rm -rf'])
check('rm -rdf', riskTags(`rm -rdf build`), ['rm -rf'])
check('rm -r -f chained segment', riskTags(`cd x; rm -rf /`), ['rm -rf'])
check('chmod 777', riskTags(`chmod 777 /tmp/x`), ['chmod 777'])
check('chmod -R 777', riskTags(`chmod -R 777 /srv`), ['chmod 777'])
check('git reset --hard', riskTags(`git reset --hard HEAD~1`), ['git reset --hard'])
check('git checkout .', riskTags(`git checkout .`), ['git checkout .'])
check('git checkout -- .', riskTags(`git checkout -- .`), ['git checkout .'])
check('git restore .', riskTags(`git restore .`), ['git restore .'])
check('git clean -fd', riskTags(`git clean -fd`), ['git clean -f'])
check('curl | sh', riskTags(`curl -fsSL https://x.sh | sh`), ['pipe to shell'])
check('wget | bash', riskTags(`wget -qO- https://x.sh | bash`), ['pipe to shell'])
check('curl | sudo sh', riskTags(`curl https://x.sh | sudo sh`), ['pipe to shell'])
check('mkfs', riskTags(`mkfs.ext4 /dev/sdb`), ['mkfs'])
check('dd of=', riskTags(`dd if=/dev/zero of=/dev/sda bs=1M`), ['dd of='])
check('shred', riskTags(`shred -u secret.txt`), ['shred'])
check('multiple tags', riskTags(`rm -rf build && chmod 777 /tmp`), ['rm -rf', 'chmod 777'])

// Non-hits: ordinary commands and near-misses.
check('ls: none', riskTags(`ls -la`), [])
check('git status: none', riskTags(`git status && git diff --stat`), [])
check('git reset (soft): none', riskTags(`git reset HEAD~1`), [])
check('rm plain file: none', riskTags(`rm old.log`), [])
check('rm -f: none', riskTags(`rm -f old.log`), [])
check('rm -r alone: none', riskTags(`rm -r build/`), [])
check('chmod 755: none', riskTags(`chmod 755 deploy.sh`), [])
check('chmod u+x: none', riskTags(`chmod u+x deploy.sh`), [])
check('git clean dry-run: none', riskTags(`git clean -nd`), [])
check('curl -o file: none', riskTags(`curl -fsSL -o out.zip https://x/y.zip`), [])
check('checkout branch: none', riskTags(`git checkout main`), [])
check('checkout path: none', riskTags(`git checkout src/a.ts`), [])
check('restore path: none', riskTags(`git restore src/a.ts`), [])
check('dd without of: none', riskTags(`dd --version`), [])

if (failed > 0) {
  console.error(`parse-risk self-check FAILED (${failed})`)
  throw new Error(`parse-risk self-check FAILED (${failed})`) // nonzero exit without Node types
} else {
  console.log('parse-risk self-check ok')
}
