import { spawn } from 'node:child_process'
import { existsSync, statSync, watch } from 'node:fs'
import { createConnection } from 'node:net'
import process from 'node:process'

import { defineCommand } from 'citty'
import { debounce } from 'perfect-debounce'
import { resolveModulePath } from 'exsolve'
import { join, resolve } from 'pathe'
import { readTSConfig } from 'pkg-types'
import { isBun } from 'std-env'
import { x } from 'tinyexec'

import { FileChangeTracker } from '../dev/utils'
import { loadKit } from '../utils/kit'
import { cwdArgs, dotEnvArgs, extendsArgs, legacyRootDirArgs, logLevelArgs } from './_shared'

export default defineCommand({
  meta: {
    name: 'typecheck',
    description: 'Runs `vue-tsc` to check types throughout your app.',
  },
  args: {
    ...cwdArgs,
    ...logLevelArgs,
    ...dotEnvArgs,
    ...extendsArgs,
    ...legacyRootDirArgs,
    port: {
      type: 'string',
      description: 'Dev server port to check before regenerating types. Skips type generation if the port is reachable. When not set, the port is resolved from NUXT_PORT, NITRO_PORT, or PORT env vars (default: 3000).',
      valueHint: 'port',
    },
    watch: {
      type: 'boolean',
      description: 'Watch for file changes and re-check types continuously',
      alias: 'w',
    },
  },
  async run(ctx) {
    process.env.NODE_ENV = process.env.NODE_ENV || 'production'

    const cwd = resolve(ctx.args.cwd || ctx.args.rootDir)
    const buildDir = join(cwd, '.nuxt')

    const explicitPort = ctx.args.port ? Number.parseInt(ctx.args.port, 10) : undefined

    const [tsConfig, resolvedTypeScript, resolvedVueTsc] = await Promise.all([
      readTSConfig(cwd),
      resolveModulePath('typescript', { try: true }),
      resolveModulePath('vue-tsc/bin/vue-tsc.js', { try: true }),
      prepareTypes(cwd, buildDir, ctx, explicitPort),
    ])

    const supportsProjects = !!(tsConfig.references?.length)
    const vueTsc = resolvedTypeScript && resolvedVueTsc ? resolvedVueTsc : null

    // Watch mode branch
    if (ctx.args.watch) {
      if (!vueTsc) {
        throw new Error('vue-tsc not found. Install it with: npm install vue-tsc typescript')
      }
      return await runWatchMode(cwd, vueTsc, supportsProjects, ctx)
    }

    if (supportsProjects && vueTsc) {
      return await typecheckParallel(cwd, buildDir, vueTsc, tsConfig.references!)
    }

    const typeCheckArgs = supportsProjects ? ['-b', '--noEmit'] : ['--noEmit']

    if (vueTsc) {
      return await x(vueTsc, typeCheckArgs, {
        throwOnError: true,
        nodeOptions: { stdio: 'inherit', cwd },
      })
    }

    if (isBun) {
      await x('bun', ['install', 'typescript', 'vue-tsc', '--global', '--silent'], {
        throwOnError: true,
        nodeOptions: { stdio: 'inherit', cwd },
      })
      return await x('bunx', ['vue-tsc', ...typeCheckArgs], {
        throwOnError: true,
        nodeOptions: { stdio: 'inherit', cwd },
      })
    }

    await x('npx', ['-p', 'vue-tsc', '-p', 'typescript', 'vue-tsc', ...typeCheckArgs], {
      throwOnError: true,
      nodeOptions: { stdio: 'inherit', cwd },
    })
  },
})

/**
 * Run vue-tsc on each project reference in parallel with incremental caching.
 * Falls back to sequential `-b` if any project config is missing.
 */
async function typecheckParallel(
  cwd: string,
  buildDir: string,
  vueTsc: string,
  references: { path: string }[],
) {
  const projects = references.map(ref => resolve(cwd, ref.path))

  // Verify all referenced tsconfigs exist
  if (projects.some(p => !existsSync(p.endsWith('.json') ? p : `${p}/tsconfig.json`))) {
    return await x(vueTsc, ['-b', '--noEmit'], {
      throwOnError: true,
      nodeOptions: { stdio: 'inherit', cwd },
    })
  }

  const results = await Promise.allSettled(
    projects.map((projectPath) => {
      const configFile = projectPath.endsWith('.json') ? projectPath : `${projectPath}/tsconfig.json`
      const buildInfoFile = configFile.replace(/\.json$/, '.tsbuildinfo')

      return x(vueTsc, [
        '--noEmit',
        '--incremental',
        '--tsBuildInfoFile', buildInfoFile,
        '-p', configFile,
      ], {
        throwOnError: true,
        nodeOptions: { stdio: 'inherit', cwd },
      })
    }),
  )

  const failed = results.some(r => r.status === 'rejected')
  if (failed) {
    throw results.find(r => r.status === 'rejected')!.reason
  }
}

/**
 * Resolve the base port the Nuxt dev server would use.
 *
 * Mirrors the resolution order from `nuxi dev`:
 *   CLI --port → NUXT_PORT → NITRO_PORT → PORT → 3000
 *
 * Since we don't have the CLI args here, we read the env vars.
 */
function resolveBasePort(): number {
  const envPort = process.env.NUXT_PORT || process.env.NITRO_PORT || process.env.PORT
  if (envPort) {
    const parsed = Number.parseInt(envPort, 10)
    if (!Number.isNaN(parsed) && parsed > 0 && parsed < 65536) {
      return parsed
    }
  }
  return 3000
}

/**
 * Check if a Nuxt dev server is running by probing the expected dev port.
 *
 * Uses Node.js `net.createConnection` — works identically on Windows, Linux,
 * and macOS without admin rights and without triggering antivirus software
 * (standard localhost TCP connection).
 *
 * When an explicit port is provided (via --port), only that port is checked.
 * Otherwise resolves the base port from env vars (NUXT_PORT, NITRO_PORT, PORT)
 * with fallback to 3000, then checks that port + the next 4 (Nuxt auto-increments
 * via get-port-please when the port is already taken).
 */
function isDevServerRunning(explicitPort?: number, host = 'localhost'): Promise<boolean> {
  const ports = explicitPort
    ? [explicitPort]
    : Array.from({ length: 5 }, (_, i) => resolveBasePort() + i)

  return Promise.any(
    ports.map(port =>
      new Promise<boolean>((resolve, reject) => {
        const socket = createConnection({ port, host })
        socket.setTimeout(300)
        socket.on('connect', () => {
          socket.destroy()
          resolve(true)
        })
        socket.on('error', () => reject(new Error('not open')))
        socket.on('timeout', () => {
          socket.destroy()
          reject(new Error('timeout'))
        })
      }),
    ),
  ).catch(() => false)
}

/**
 * Generate types only when needed:
 * - Always generate if .nuxt types don't exist yet
 * - Always generate in CI environments
 * - Skip if the dev server is running (it keeps types in sync via HMR)
 * - Generate if dev server is not running (types could be stale)
 */
async function prepareTypes(
  cwd: string,
  buildDir: string,
  ctx: { args: { dotenv?: string, logLevel?: string, extends?: string }, data?: { overrides?: Record<string, any> } },
  explicitPort?: number,
) {
  const typesExist = existsSync(join(buildDir, 'tsconfig.app.json'))
  const isCI = process.env.CI === 'true' || process.env.CI === '1'

  // No types at all — must generate
  if (!typesExist) {
    return await generateTypes(cwd, ctx)
  }

  // CI always regenerates for safety
  if (isCI) {
    return await generateTypes(cwd, ctx)
  }

  // Dev server running — types are kept in sync, skip prepare
  if (await isDevServerRunning(explicitPort)) {
    return
  }

  // Dev server not running — types could be stale, regenerate
  return await generateTypes(cwd, ctx)
}

async function generateTypes(
  cwd: string,
  ctx: { args: { dotenv?: string, logLevel?: string, extends?: string }, data?: { overrides?: Record<string, any> } },
) {
  const { loadNuxt, buildNuxt, writeTypes } = await loadKit(cwd)
  const nuxt = await loadNuxt({
    cwd,
    dotenv: { cwd, fileName: ctx.args.dotenv },
    overrides: {
      _prepare: true,
      logLevel: ctx.args.logLevel as 'silent' | 'info' | 'verbose' | undefined,
      ...ctx.data?.overrides,
      ...(ctx.args.extends && { extends: ctx.args.extends }),
    },
  })

  await writeTypes(nuxt)
  await buildNuxt(nuxt)
  await nuxt.close()
}

/**
 * Run vue-tsc in watch mode with auto-import detection.
 *
 * This function never returns - it keeps running until Ctrl-C.
 *
 * Architecture:
 * - Spawns vue-tsc --watch as child process
 * - Watches composables directories for NEW files
 * - On new composable: restart vue-tsc after regenerating types
 */
async function runWatchMode(
  cwd: string,
  vueTsc: string,
  supportsProjects: boolean,
  ctx: { args: { dotenv?: string, logLevel?: string, extends?: string }, data?: { overrides?: Record<string, any> } },
): Promise<never> {
  let vueTscProcess: ReturnType<typeof spawn> | null = null
  let isRestarting = false
  const changeTracker = new FileChangeTracker()

  // Directories to watch for new composables
  const watchDirs = [
    join(cwd, 'composables'),
    join(cwd, 'app', 'composables'),
    join(cwd, 'app', 'domains'),
  ].filter((dir) => {
    try {
      return statSync(dir).isDirectory()
    }
    catch {
      return false
    }
  })

  // Prime change tracker to avoid false positives on startup
  for (const dir of watchDirs) {
    try {
      changeTracker.prime(dir, true)
    }
    catch {
      // Ignore
    }
  }

  /**
   * Start vue-tsc in watch mode
   */
  function startVueTsc() {
    const args = ['--noEmit', '--watch']
    if (supportsProjects) {
      args.unshift('-b')
    }

    console.log('\n[nuxi] Starting type checking in watch mode...\n')

    vueTscProcess = spawn('node', [vueTsc, ...args], {
      cwd,
      stdio: 'inherit',
      shell: false,
    })

    vueTscProcess.on('exit', (code, signal) => {
      if (!isRestarting && signal !== 'SIGTERM') {
        console.log(`\n[nuxi] vue-tsc exited unexpectedly (code: ${code}, signal: ${signal})`)
        process.exit(code ?? 1)
      }
    })

    vueTscProcess.on('error', (err) => {
      console.error('[nuxi] Failed to start vue-tsc:', err)
      process.exit(1)
    })
  }

  /**
   * Restart vue-tsc after regenerating types
   */
  async function restartVueTsc() {
    if (isRestarting)
      return
    isRestarting = true

    console.log('\n[nuxi] New composable detected, regenerating types...\n')

    // Kill existing process
    if (vueTscProcess) {
      vueTscProcess.kill('SIGTERM')
      vueTscProcess = null
      // Wait for clean exit
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    // Regenerate types
    try {
      await generateTypes(cwd, ctx)
    }
    catch (error) {
      console.error('[nuxi] Failed to regenerate types:', error)
      isRestarting = false
      return
    }

    // Restart vue-tsc
    startVueTsc()
    isRestarting = false
  }

  /**
   * Check if file is a new composable
   */
  function isNewComposable(filePath: string): boolean {
    // Only TypeScript/JavaScript/Vue files
    if (!/\.(ts|js|vue)$/.test(filePath))
      return false

    // Must be in watched directories
    const inWatchedDir = watchDirs.some(dir => filePath.startsWith(dir))
    if (!inWatchedDir)
      return false

    // Check if it's a NEW file (not just modified)
    return changeTracker.shouldEmitChange(filePath)
  }

  // Debounced restart to batch multiple file additions
  const debouncedRestart = debounce(restartVueTsc, 500)

  /**
   * Watch composables directories
   */
  const watchers = watchDirs.map(dir =>
    watch(dir, { recursive: true }, (event, filename) => {
      if (!filename)
        return

      const fullPath = join(dir, filename)

      if (event === 'rename' && isNewComposable(fullPath)) {
        debouncedRestart()
      }
    }),
  )

  /**
   * Graceful shutdown on Ctrl-C
   */
  function cleanup() {
    console.log('\n[nuxi] Shutting down watch mode...')

    // Close file watchers
    watchers.forEach(watcher => watcher.close())

    // Kill vue-tsc
    if (vueTscProcess) {
      vueTscProcess.kill('SIGTERM')
    }

    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)

  // Start initial vue-tsc
  startVueTsc()

  // Keep alive forever
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await new Promise(resolve => setTimeout(resolve, 2147483647)) // Max safe timeout (24.8 days)
  }
}
