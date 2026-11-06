// 天枢域的目录语义与变量（我们拥有这些目录的所有权，所以规则可以写成断言而不是猜测）
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export function tianshuVars({ projectRoot = process.cwd() } = {}) {
  return {
    domain: 'tianshu',
    rivetHome: join(homedir(), '.rivet'),
    projectRivetHome: join(projectRoot, '.rivet'),
    tmpDir: tmpdir(),
    unmatchedRoots: [join(homedir(), '.rivet'), join(projectRoot, '.rivet')],
  }
}
