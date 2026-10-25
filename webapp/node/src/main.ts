import express, { Request, Response, NextFunction, RequestHandler } from 'express'
import cookieParser from 'cookie-parser'
import bodyParser from 'body-parser'
import multer from 'multer'
import mysql, { RowDataPacket, OkPacket } from 'mysql2/promise'
import childProcess from 'child_process'
import cluster from 'cluster'
import { readFile } from 'fs/promises'
import jwt from 'jsonwebtoken'
import util from 'util'
import path from 'path'
import sqlite3 from 'sqlite3'
import { open, Database } from 'sqlite'
import { parse } from 'csv-parse/sync'

import { useSqliteTraceHook } from './sqltrace'

// SQLite のクエリは libuv のスレッドプールで実行されるので、遅いクエリで他のクエリが詰まらないよう増やしておく
process.env.UV_THREADPOOL_SIZE ??= '16'

const exec = util.promisify(childProcess.exec)

// constants
const tenantDBSchemaFilePaths = ['../sql/tenant/10_schema.sql', '../sql/tenant/20_index.sql']
const initializeScript = '../sql/init.sh'
const cookieName = 'isuports_session'

const RoleAdmin = 'admin'
const RoleOrganizer = 'organizer'
const RolePlayer = 'player'
const RoleNone = 'none'

const tenantNameRegexp = /^[a-z][a-z0-9-]{0,61}[a-z0-9]$/

// SQLite のバインド変数の上限を超えないよう、まとめて INSERT する行数
const bulkInsertChunkSize = 500

// 環境変数を取得する、なければデフォルト値を返す
function getEnv(key: string, defaultValue: string): string {
  const val = process.env[key]
  if (val !== undefined) {
    return val
  }

  return defaultValue
}

// 管理用DBに接続する
const dbConfig = {
  host: process.env['ISUCON_DB_HOST'] ?? '127.0.0.1',
  port: Number(process.env['ISUCON_DB_PORT'] ?? 3306),
  user: process.env['ISUCON_DB_USER'] ?? 'isucon',
  password: process.env['ISUCON_DB_PASSWORD'] ?? 'isucon',
  database: process.env['ISUCON_DB_NAME'] ?? 'isucon_listen80',
  connectionLimit: 20,
}
const adminDB = mysql.createPool(dbConfig)

// テナントDBのパスを返す
function tenantDBPath(id: number): string {
  const tenantDBDir = getEnv('ISUCON_TENANT_DB_DIR', '../tenant_db')
  return path.join(tenantDBDir, `${id.toString()}.db`)
}

// テナントDBに接続する
async function connectToTenantDB(id: number): Promise<Database> {
  const p = tenantDBPath(id)
  let db: Database
  try {
    db = await open({
      filename: p,
      driver: sqlite3.Database,
    })
    db.configure('busyTimeout', 5000)
    await db.exec('PRAGMA journal_mode = WAL')

    const traceFilePath = getEnv('ISUCON_SQLITE_TRACE_FILE', '')
    if (traceFilePath) {
      db = useSqliteTraceHook(db, traceFilePath)
    }
  } catch (error) {
    throw new Error(`failed to open tenant DB: ${error}`)
  }

  return db
}

// テナントDBへの接続をテナントごとにプールして使い回す
// node-sqlite3 は1つの接続を複数のクエリで共有すると、遅いクエリの実行中にメインスレッドが接続のロック待ちで止まることがあるので、
// 接続はリクエストごとに貸し出して同時に1つの処理からしか使わないようにする
const maxIdleTenantDBs = 8
const idleTenantDBs = new Map<number, Database[]>()
let tenantDBPoolGeneration = 0

async function withTenantDB<T>(id: number, fn: (tenantDB: Database) => Promise<T>): Promise<T> {
  const generation = tenantDBPoolGeneration
  const tenantDB = idleTenantDBs.get(id)?.pop() ?? (await connectToTenantDB(id))
  try {
    return await fn(tenantDB)
  } finally {
    const idle = idleTenantDBs.get(id) ?? []
    if (generation === tenantDBPoolGeneration && idle.length < maxIdleTenantDBs) {
      idle.push(tenantDB)
      idleTenantDBs.set(id, idle)
    } else {
      await tenantDB.close()
    }
  }
}

async function closeIdleTenantDBs(): Promise<void> {
  tenantDBPoolGeneration++
  const dbs = [...idleTenantDBs.values()].flat()
  idleTenantDBs.clear()
  await Promise.all(dbs.map((db) => db.close().catch(() => undefined)))
}

// テナントDBへの書き込みをテナントごとに直列化する
// SQLite は書き込みが1つずつしかできないので、プロセス内で順番待ちさせて SQLite のロック待ち(ビジーウェイト)を起こさない
const tenantWriteLocks = new Map<number, Promise<void>>()

async function withTenantWriteLock<T>(id: number, fn: () => Promise<T>): Promise<T> {
  const previous = tenantWriteLocks.get(id) ?? Promise.resolve()
  let release!: () => void
  const current = previous.then(() => new Promise<void>((resolve) => (release = resolve)))
  tenantWriteLocks.set(id, current)
  await previous
  try {
    return await fn()
  } finally {
    release()
    if (tenantWriteLocks.get(id) === current) {
      tenantWriteLocks.delete(id)
    }
  }
}

// テナントDBを新規に作成する
async function createTenantDB(id: number): Promise<Error | undefined> {
  const p = tenantDBPath(id)
  const schemaFiles = tenantDBSchemaFilePaths.join(' ')

  try {
    await exec(`sh -c "cat ${schemaFiles} | sqlite3 ${p}"`)
  } catch (error: any) {
    return new Error(`failed to exec "cat ${schemaFiles} | sqlite3 ${p}", out=${error.stderr}`)
  }
}

// システム全体で一意なIDを生成する
// id_generator からまとめて採番した範囲をプロセス内で払い出す
const idBlockSize = 1000
let nextID = 1
let maxID = 0
let reservingIDBlock: Promise<void> | undefined

async function reserveIDBlock(): Promise<void> {
  try {
    const [result] = await adminDB.execute<OkPacket>(
      'UPDATE id_generator SET id = LAST_INSERT_ID(id + ?) WHERE stub = ?',
      [idBlockSize, 'a']
    )
    maxID = result.insertId
    nextID = maxID - idBlockSize + 1
  } catch (error) {
    throw new Error(`error UPDATE id_generator: ${error}`)
  }
}

async function dispenseID(): Promise<string> {
  while (nextID > maxID) {
    if (!reservingIDBlock) {
      reservingIDBlock = reserveIDBlock().finally(() => {
        reservingIDBlock = undefined
      })
    }
    await reservingIDBlock
  }
  return (nextID++).toString(16)
}

function resetIDBlock() {
  nextID = 1
  maxID = 0
}

// カスタムエラーハンドラにステータスコード拾ってもらうエラー型
class ErrorWithStatus extends Error {
  public status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = new.target.name
    this.status = status
  }
}

// 内部型定義
type TenantWithBilling = {
  id: string
  name: string
  display_name: string
  billing: number
}

type TenantDetail = {
  name: string
  display_name: string
}

type BillingReport = {
  competition_id: string
  competition_title: string
  player_count: number // スコアを登録した参加者数
  visitor_count: number // ランキングを閲覧だけした(スコアを登録していない)参加者数
  billing_player_yen: number // 請求金額 スコアを登録した参加者分
  billing_visitor_yen: number // 請求金額 ランキングを閲覧だけした(スコアを登録していない)参加者分
  billing_yen: number // 合計請求金額
}

type PlayerDetail = {
  id: string
  display_name: string
  is_disqualified: boolean
}

type CompetitionDetail = {
  id: string
  title: string
  is_finished: boolean
}

type PlayerScoreDetail = {
  competition_title: string
  score: number
}

type CompetitionRank = {
  rank: number
  score: number
  player_id: string
  player_display_name: string
}

// アクセスしてきた人の情報
type Viewer = {
  role: string
  playerId: string
  tenantName: string
  tenantId: number
}

// レスポンス型定義
type TenantsAddResult = {
  tenant: TenantWithBilling
}
type InitializeResult = {
  lang: string
}

type PlayersListResult = {
  players: PlayerDetail[]
}
type PlayersAddResult = {
  players: PlayerDetail[]
}
type PlayerDisqualifiedResult = {
  player: PlayerDetail
}

type CompetitionsAddResult = {
  competition: CompetitionDetail
}
type ScoreResult = {
  rows: number
}
type BillingResult = {
  reports: BillingReport[]
}

type CompetitionsResult = {
  competitions: CompetitionDetail[]
}

type PlayerResult = {
  player: PlayerDetail
  scores: PlayerScoreDetail[]
}
type CompetitionRankingResult = {
  competition: CompetitionDetail
  ranks: CompetitionRank[]
}

type MeResult = {
  tenant: TenantDetail
  me: PlayerDetail | null
  role: string
  logged_in: boolean
}

// DB型定義
interface TenantRow {
  id: number
  name: string
  display_name: string
  created_at?: number
  updated_at?: number
}

interface CompetitionRow {
  tenant_id: number
  id: string
  title: string
  finished_at: number | null
  created_at: number
  updated_at: number
}

interface VisitHistorySummaryRow {
  competition_id: string
  player_id: string
  min_created_at: number
}

interface PlayerRow {
  tenant_id: number
  id: string
  display_name: string
  is_disqualified: number
  created_at: number
  updated_at: number
}

interface PlayerScoreRow {
  tenant_id: number
  id: string
  player_id: string
  competition_id: string
  score: number
  row_num: number
  created_at: number
  updated_at: number
}

const app = express()
app.use(express.json())
app.use(cookieParser())
app.use(bodyParser.urlencoded({ extended: false }))
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.set('Cache-Control', 'private')
  next()
})
app.set('etag', false)

const upload = multer()

// see: https://expressjs.com/en/advanced/best-practice-performance.html#handle-exceptions-properly
// ステータスを持たないエラーはエラー処理関数で 500 として扱う
const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<Response | void>): RequestHandler =>
  (req, res, next) =>
    fn(req, res, next).catch(next)

function unixNow(): number {
  return Math.floor(new Date().getTime() / 1000)
}

function toPlayerDetail(player: PlayerRow): PlayerDetail {
  return {
    id: player.id,
    display_name: player.display_name,
    is_disqualified: !!player.is_disqualified,
  }
}

function toCompetitionDetail(comp: CompetitionRow): CompetitionDetail {
  return {
    id: comp.id,
    title: comp.title,
    is_finished: !!comp.finished_at,
  }
}

// JWT検証用の公開鍵はプロセス内で1度だけ読み込む
let jwtPublicKey: Promise<Buffer> | undefined
function getJWTPublicKey(): Promise<Buffer> {
  if (!jwtPublicKey) {
    jwtPublicKey = readFile(getEnv('ISUCON_JWT_KEY_FILE', '../public.pem'))
    jwtPublicKey.catch(() => {
      jwtPublicKey = undefined
    })
  }
  return jwtPublicKey
}

// 署名検証済みのトークンのキャッシュ
// RS256 の署名検証は重いので、同じトークンは有効期限(exp)まで検証結果を使い回す
const maxVerifiedTokens = 100000
const verifiedTokens = new Map<string, jwt.JwtPayload>()

function verifyToken(tokenStr: string, cert: Buffer): jwt.JwtPayload {
  const cached = verifiedTokens.get(tokenStr)
  // jsonwebtoken と同じく、現在時刻(秒)が exp 以上なら期限切れとして検証し直す(エラーになる)
  if (cached && (cached.exp === undefined || Math.floor(Date.now() / 1000) < cached.exp)) {
    return cached
  }

  const token = jwt.verify(tokenStr, cert, {
    algorithms: ['RS256'],
  }) as jwt.JwtPayload
  if (verifiedTokens.size >= maxVerifiedTokens) {
    verifiedTokens.clear()
  }
  verifiedTokens.set(tokenStr, token)
  return token
}

// リクエストヘッダをパースしてViewerを返す
async function parseViewer(req: Request): Promise<Viewer> {
  const tokenStr = req.cookies[cookieName]
  if (!tokenStr) {
    throw new ErrorWithStatus(401, `cookie ${cookieName} is not found`)
  }

  const cert = await getJWTPublicKey()

  let token: jwt.JwtPayload
  try {
    token = verifyToken(tokenStr, cert)
  } catch (error) {
    throw new ErrorWithStatus(401, `${error}`)
  }

  if (!token.sub) {
    throw new ErrorWithStatus(401, `invalid token: subject is not found in token: ${tokenStr}`)
  }
  const subject = token.sub

  const tr: string | undefined = token['role']
  if (!tr) {
    throw new ErrorWithStatus(401, `invalid token: role is not found: ${tokenStr}`)
  }

  let role = ''
  switch (tr) {
    case RoleAdmin:
    case RoleOrganizer:
    case RolePlayer:
      role = tr
      break

    default:
      throw new ErrorWithStatus(401, `invalid token: invalid role: ${tokenStr}"`)
  }

  // aud は1要素で、テナント名が入っている
  const aud: string[] | undefined = token.aud as string[]
  if (!aud || aud.length !== 1) {
    throw new ErrorWithStatus(401, `invalid token: aud field is few or too much: ${tokenStr}`)
  }

  const tenant = await retrieveTenantRowFromHeader(req)
  if (!tenant) {
    throw new ErrorWithStatus(401, 'tenant not found')
  }
  if (tenant.name === 'admin' && role !== RoleAdmin) {
    throw new ErrorWithStatus(401, 'tenant not found')
  }
  if (tenant.name !== aud[0]) {
    throw new ErrorWithStatus(401, `invalid token: tenant name is not match with ${req.hostname}: ${tokenStr}`)
  }

  return {
    role: role,
    playerId: subject,
    tenantName: tenant.name,
    tenantId: tenant.id ?? 0,
  }
}

// ロールを確認してViewerを返す
async function parseViewerWithRole(req: Request, role: string, message: string): Promise<Viewer> {
  const viewer = await parseViewer(req)
  if (viewer.role !== role) {
    throw new ErrorWithStatus(403, message)
  }
  return viewer
}

// テナントは削除されない(初期化時を除く)ので、名前で引いた結果をキャッシュする
const tenantCache = new Map<string, TenantRow>()

async function retrieveTenantRowFromHeader(req: Request): Promise<TenantRow | undefined> {
  // JWTに入っているテナント名とHostヘッダのテナント名が一致しているか確認
  const baseHost = getEnv('ISUCON_BASE_HOSTNAME', '.t.isucon.dev')
  const tenantName = req.hostname.replace(baseHost, '')

  // SaaS管理者用ドメイン
  if (tenantName === 'admin') {
    return {
      id: 0,
      name: 'admin',
      display_name: 'admin',
    }
  }

  const cached = tenantCache.get(tenantName)
  if (cached) {
    return cached
  }

  // テナントの存在確認
  try {
    const [[tenantRow]] = await adminDB.query<(TenantRow & RowDataPacket)[]>('SELECT * FROM tenant WHERE name = ?', [
      tenantName,
    ])
    if (tenantRow) {
      tenantCache.set(tenantName, tenantRow)
    }
    return tenantRow
  } catch (error) {
    throw new Error(`failed to Select tenant: name=${tenantName}, ${error}`)
  }
}

// 参加者を取得する
async function retrievePlayer(tenantDB: Database, id: string): Promise<PlayerRow | undefined> {
  try {
    const playerRow = await tenantDB.get<PlayerRow>('SELECT * FROM player WHERE id = ?', id)
    return playerRow
  } catch (error) {
    throw new Error(`error Select player: id=${id}, ${error}`)
  }
}

// 参加者を認可する
// 参加者向けAPIで呼ばれる
async function authorizePlayer(tenantDB: Database, id: string): Promise<void> {
  const player = await retrievePlayer(tenantDB, id)
  if (!player) {
    throw new ErrorWithStatus(401, 'player not found')
  }
  if (player.is_disqualified) {
    throw new ErrorWithStatus(403, 'player is disqualified')
  }
}

// 大会を取得する
async function retrieveCompetition(tenantDB: Database, id: string): Promise<CompetitionRow | undefined> {
  try {
    const competitionRow = await tenantDB.get<CompetitionRow>('SELECT * FROM competition WHERE id = ?', id)
    return competitionRow
  } catch (error) {
    throw new Error(`error Select competition: id=${id}, ${error}`)
  }
}

// 大会の一覧を新しい順に取得する
async function listCompetitions(tenantDB: Database, tenantId: number): Promise<CompetitionRow[]> {
  return tenantDB.all<CompetitionRow[]>(
    'SELECT * FROM competition WHERE tenant_id = ? ORDER BY created_at DESC',
    tenantId
  )
}

// SQL の IN 句用のプレースホルダを返す
function placeholders(n: number): string {
  return Array(n).fill('?').join(', ')
}

// 複数行をまとめて INSERT する
async function bulkInsert(tenantDB: Database, table: string, columns: string[], rows: unknown[][]): Promise<void> {
  const rowPlaceholder = `(${placeholders(columns.length)})`
  for (let i = 0; i < rows.length; i += bulkInsertChunkSize) {
    const chunk = rows.slice(i, i + bulkInsertChunkSize)
    await tenantDB.run(
      `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${Array(chunk.length).fill(rowPlaceholder).join(', ')}`,
      chunk.flat()
    )
  }
}

// SaaS管理者向けAPI
// テナントを追加する
// POST /api/admin/tenants/add
app.post(
  '/api/admin/tenants/add',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewer(req)
    if (viewer.tenantName !== 'admin') {
      // admin: SaaS管理者用の特別なテナント名
      throw new ErrorWithStatus(404, `${viewer.tenantName} has not this API`)
    }
    if (viewer.role !== RoleAdmin) {
      throw new ErrorWithStatus(403, 'admin role required')
    }

    const { name, display_name } = req.body
    if (!validateTenantName(name)) {
      throw new ErrorWithStatus(400, `invalid tenant name: ${name}`)
    }

    const now = unixNow()
    let id: number
    try {
      const [result] = await adminDB.execute<OkPacket>(
        'INSERT INTO tenant (name, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
        [name, display_name, now, now]
      )
      id = result.insertId
    } catch (error: any) {
      // duplicate entry
      if (error.errno && error.errno === 1062) {
        throw new ErrorWithStatus(400, 'duplicate tenant')
      }
      throw new Error(
        `error Insert tenant: name=${name}, displayName=${display_name}, createdAt=${now}, updatedAt=${now}, ${error}`
      )
    }

    // NOTE: 先にadminDBに書き込まれることでこのAPIの処理中に
    //       /api/admin/tenants/billingにアクセスされるとエラーになりそう
    //       ロックなどで対処したほうが良さそう
    const error = await createTenantDB(id)
    if (error) {
      throw new Error(`error createTenantDB: id=${id} name=${name}, ${error}`)
    }

    const data: TenantsAddResult = {
      tenant: {
        id: id.toString(),
        name,
        display_name,
        billing: 0,
      },
    }
    res.status(200).json({
      status: true,
      data,
    })
  })
)

// テナント名が規則に沿っているかチェックする
function validateTenantName(name: string): boolean {
  if (name.match(tenantNameRegexp)) {
    return true
  }
  return false
}

function buildBillingReport(comp: CompetitionRow, playerCount: number, visitorCount: number): BillingReport {
  return {
    competition_id: comp.id,
    competition_title: comp.title,
    player_count: playerCount,
    visitor_count: visitorCount,
    billing_player_yen: 100 * playerCount,
    billing_visitor_yen: 10 * visitorCount,
    billing_yen: 100 * playerCount + 10 * visitorCount,
  }
}

// 終了した大会の課金レポートのキャッシュ
// 終了後はスコアを入稿できず、終了後の訪問も課金対象にならないので、終了から十分時間が経てば課金額は変わらない
// (終了直後は、終了前に処理が始まったリクエストの書き込みが反映されきっていない可能性があるのでキャッシュしない)
const billingReportCache = new Map<string, BillingReport>()
const billingSettleSeconds = 3

// 大会ごとの課金レポートを計算する
// 返り値は competitions と同じ順序で並ぶ
async function billingReportsByCompetitions(
  tenantDB: Database,
  tenantId: number,
  competitions: CompetitionRow[]
): Promise<BillingReport[]> {
  const now = unixNow()
  const reports = new Map<string, BillingReport>()
  const targets: CompetitionRow[] = []
  for (const comp of competitions) {
    if (!comp.finished_at) {
      // 大会が終了している場合のみ請求金額が確定するので、終了していない大会は0円
      reports.set(comp.id, buildBillingReport(comp, 0, 0))
      continue
    }
    const cached = billingReportCache.get(`${tenantId}:${comp.id}`)
    if (cached) {
      reports.set(comp.id, cached)
    } else {
      targets.push(comp)
    }
  }

  if (targets.length > 0) {
    const targetIds = targets.map((comp) => comp.id)
    const [[vhs], scoredPlayers] = await Promise.all([
      // ランキングにアクセスした参加者のIDを取得する
      adminDB.query<(VisitHistorySummaryRow & RowDataPacket)[]>(
        `SELECT competition_id, player_id, MIN(created_at) AS min_created_at FROM visit_history WHERE tenant_id = ? AND competition_id IN (${placeholders(
          targetIds.length
        )}) GROUP BY competition_id, player_id`,
        [tenantId, ...targetIds]
      ),
      // スコアを登録した参加者のIDを取得する
      tenantDB.all<{ competition_id: string; player_id: string }[]>(
        `SELECT DISTINCT competition_id, player_id FROM player_score WHERE tenant_id = ? AND competition_id IN (${placeholders(
          targetIds.length
        )})`,
        tenantId,
        ...targetIds
      ),
    ])

    const billingMaps = new Map<string, Map<string, 'player' | 'visitor'>>(targetIds.map((id) => [id, new Map()]))
    const finishedAt = new Map(targets.map((comp) => [comp.id, comp.finished_at as number]))
    for (const vh of vhs) {
      // competition.finished_atよりもあとの場合は、終了後に訪問したとみなして大会開催内アクセス済みとみなさない
      if ((finishedAt.get(vh.competition_id) as number) < vh.min_created_at) {
        continue
      }
      billingMaps.get(vh.competition_id)?.set(vh.player_id, 'visitor')
    }
    for (const sp of scoredPlayers) {
      // スコアが登録されている参加者
      billingMaps.get(sp.competition_id)?.set(sp.player_id, 'player')
    }

    for (const comp of targets) {
      const counts = {
        player: 0,
        visitor: 0,
      }
      for (const category of billingMaps.get(comp.id)?.values() ?? []) {
        counts[category]++
      }
      const report = buildBillingReport(comp, counts.player, counts.visitor)
      reports.set(comp.id, report)
      if (now > (comp.finished_at as number) + billingSettleSeconds) {
        billingReportCache.set(`${tenantId}:${comp.id}`, report)
      }
    }
  }

  return competitions.map((comp) => reports.get(comp.id) as BillingReport)
}

// テナントの課金額を計算する
async function tenantBilling(tenant: TenantRow): Promise<TenantWithBilling> {
  const reports = await withTenantDB(tenant.id, async (tenantDB) => {
    const competitions = await tenantDB.all<CompetitionRow[]>(
      'SELECT * FROM competition WHERE tenant_id = ?',
      tenant.id
    )
    return billingReportsByCompetitions(tenantDB, tenant.id, competitions)
  })

  return {
    id: tenant.id.toString(),
    name: tenant.name,
    display_name: tenant.display_name,
    billing: reports.reduce((sum, report) => sum + report.billing_yen, 0),
  }
}

// SaaS管理者用API
// テナントごとの課金レポートを最大10件、テナントのid降順で取得する
// GET /api/admin/tenants/billing
// URL引数beforeを指定した場合、指定した値よりもidが小さいテナントの課金レポートを取得する
app.get(
  '/api/admin/tenants/billing',
  wrap(async (req: Request, res: Response) => {
    if (req.hostname !== getEnv('ISUCON_ADMIN_HOSTNAME', 'admin.t.isucon.dev')) {
      throw new ErrorWithStatus(404, `invalid hostname ${req.hostname}`)
    }

    await parseViewerWithRole(req, RoleAdmin, 'admin role required')

    const before = req.query.before as string
    const beforeId = before ? parseInt(before, 10) : 0
    if (isNaN(beforeId)) {
      throw new ErrorWithStatus(400, `failed to parse query parameter 'before'=${before}`)
    }

    // テナントごとに
    //   大会ごとに
    //     scoreに登録されているplayerでアクセスした人 * 100
    //     scoreに登録されていないplayerでアクセスした人 * 10
    //   を合計したものを
    // テナントの課金とする
    let tenants: TenantRow[]
    try {
      const [rows] =
        beforeId !== 0
          ? await adminDB.query<(TenantRow & RowDataPacket)[]>(
              'SELECT * FROM tenant WHERE id < ? ORDER BY id DESC LIMIT 10',
              [beforeId]
            )
          : await adminDB.query<(TenantRow & RowDataPacket)[]>('SELECT * FROM tenant ORDER BY id DESC LIMIT 10')
      tenants = rows
    } catch (error) {
      throw new Error(`error Select tenant: ${error}`)
    }

    const tenantBillings = await Promise.all(tenants.map((tenant) => tenantBilling(tenant)))

    res.status(200).json({
      status: true,
      data: {
        tenants: tenantBillings,
      },
    })
  })
)

// テナント管理者向けAPI - 参加者追加、一覧、失格

// テナント管理者向けAPI
// GET /api/organizer/players
// 参加者一覧を返す
app.get(
  '/api/organizer/players',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RoleOrganizer, 'role organizer required')

    let pls: PlayerRow[]
    try {
      pls = await withTenantDB(viewer.tenantId, (tenantDB) =>
        tenantDB.all<PlayerRow[]>('SELECT * FROM player WHERE tenant_id = ? ORDER BY created_at DESC', viewer.tenantId)
      )
    } catch (error) {
      throw new Error(`error Select player, tenant_id=${viewer.tenantId}: ${error}`)
    }

    const data: PlayersListResult = {
      players: pls.map(toPlayerDetail),
    }
    res.status(200).json({
      status: true,
      data,
    })
  })
)

// テナント管理者向けAPI
// POST /api/organizer/players/add
// 参加者を追加する
app.post(
  '/api/organizer/players/add',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RoleOrganizer, 'role organizer required')

    const displayNames: string[] = req.body['display_name[]']

    const pds: PlayerDetail[] = []
    const rows: unknown[][] = []
    for (const displayName of displayNames) {
      const id = await dispenseID()
      const now = unixNow()
      rows.push([id, viewer.tenantId, displayName, false, now, now])
      pds.push({
        id,
        display_name: displayName,
        is_disqualified: false,
      })
    }

    try {
      await withTenantWriteLock(viewer.tenantId, () =>
        withTenantDB(viewer.tenantId, (tenantDB) =>
          bulkInsert(
            tenantDB,
            'player',
            ['id', 'tenant_id', 'display_name', 'is_disqualified', 'created_at', 'updated_at'],
            rows
          )
        )
      )
    } catch (error) {
      throw new Error(`error Insert player at tenantDB: tenantId=${viewer.tenantId}, ${error}`)
    }

    const data: PlayersAddResult = {
      players: pds,
    }

    res.status(200).json({
      status: true,
      data,
    })
  })
)

// テナント管理者向けAPI
// POST /api/organizer/player/:player_id/disqualified
// 参加者を失格にする
app.post(
  '/api/organizer/player/:playerId/disqualified',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RoleOrganizer, 'role organizer required')

    const { playerId } = req.params
    if (!playerId) {
      throw new ErrorWithStatus(400, 'player_id is required')
    }

    const now = unixNow()
    const player = await withTenantDB(viewer.tenantId, async (tenantDB) => {
      try {
        await withTenantWriteLock(viewer.tenantId, () =>
          tenantDB.run('UPDATE player SET is_disqualified = ?, updated_at = ? WHERE id = ?', true, now, playerId)
        )
      } catch (error) {
        throw new Error(`error Update player: isDisqualified=true, updatedAt=${now}, id=${playerId}, ${error}`)
      }

      return retrievePlayer(tenantDB, playerId)
    })
    if (!player) {
      // 存在しないプレイヤー
      throw new ErrorWithStatus(404, 'player not found')
    }

    const data: PlayerDisqualifiedResult = {
      player: toPlayerDetail(player),
    }
    res.status(200).json({
      status: true,
      data,
    })
  })
)

// テナント管理者向けAPI - 大会管理

// テナント管理者向けAPI
// POST /api/organizer/competitions/add
// 大会を追加する
app.post(
  '/api/organizer/competitions/add',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RoleOrganizer, 'role organizer required')

    const { title } = req.body
    const now = unixNow()
    const id = await dispenseID()
    try {
      await withTenantWriteLock(viewer.tenantId, () =>
        withTenantDB(viewer.tenantId, (tenantDB) =>
          tenantDB.run(
            'INSERT INTO competition (id, tenant_id, title, finished_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
            id,
            viewer.tenantId,
            title,
            null,
            now,
            now
          )
        )
      )
    } catch (error) {
      throw new Error(
        `error Insert competition: id=${id}, tenant_id=${viewer.tenantId}, title=${title}, finishedAt=null, createdAt=${now}, updatedAt=${now}, ${error}`
      )
    }

    const data: CompetitionsAddResult = {
      competition: {
        id,
        title,
        is_finished: false,
      },
    }

    res.status(200).json({
      status: true,
      data,
    })
  })
)

// テナント管理者向けAPI
// POST /api/organizer/competition/:competition_id/finish
// 大会を終了する
app.post(
  '/api/organizer/competition/:competitionId/finish',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RoleOrganizer, 'role organizer required')

    const { competitionId } = req.params
    if (!competitionId) {
      throw new ErrorWithStatus(400, 'competition_id required')
    }

    const now = unixNow()
    await withTenantDB(viewer.tenantId, async (tenantDB) => {
      const competition = await retrieveCompetition(tenantDB, competitionId)
      if (!competition) {
        throw new ErrorWithStatus(404, 'competition not found')
      }

      await withTenantWriteLock(viewer.tenantId, () =>
        tenantDB.run('UPDATE competition SET finished_at = ?, updated_at = ? WHERE id = ?', now, now, competitionId)
      )
    })

    res.status(200).json({
      status: true,
    })
  })
)

// テナント管理者向けAPI
// POST /api/organizer/competition/:competitionId/score
// 大会のスコアをCSVでアップロードする
app.post(
  '/api/organizer/competition/:competitionId/score',
  upload.single('scores'),
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RoleOrganizer, 'role organizer required')

    const { competitionId } = req.params
    if (!competitionId) {
      throw new ErrorWithStatus(400, 'competition_id required')
    }

    const rowCount = await withTenantDB(viewer.tenantId, (tenantDB) =>
      saveCompetitionScores(req, viewer, competitionId, tenantDB)
    )
    if (rowCount === undefined) {
      return res.status(400).json({
        status: false,
        message: 'competition is finished',
      })
    }

    const data: ScoreResult = {
      rows: rowCount,
    }

    res.status(200).json({
      status: true,
      data,
    })
  })
)

// CSVのスコアで大会のスコアを置き換え、登録した行数を返す
// 大会が終了している場合は undefined を返す
async function saveCompetitionScores(
  req: Request,
  viewer: Viewer,
  competitionId: string,
  tenantDB: Database
): Promise<number | undefined> {
  const competition = await retrieveCompetition(tenantDB, competitionId)
  if (!competition) {
    throw new ErrorWithStatus(404, 'competition not found')
  }

  if (competition.finished_at) {
    return undefined
  }

  const file = req.file
  if (!file) {
    throw new Error('error form[scores] is not specified')
  }

  const buf = req.file?.buffer
  if (!buf) {
    throw new Error('error form[scores] has no data')
  }

  const records: any[] = parse(buf.toString(), {
    columns: true,
    skip_empty_lines: true,
  })

  const recordKeys = Object.keys(records[0])
  if (recordKeys.length !== 2 || recordKeys[0] !== 'player_id' || recordKeys[1] !== 'score') {
    throw new ErrorWithStatus(400, 'invalid CSV headers')
  }

  // CSVに登場する参加者が存在するかをまとめて確認する
  const playerIds = [...new Set<string>(records.map((record) => record.player_id))]
  const existingPlayerIds = new Set<string>()
  for (let i = 0; i < playerIds.length; i += bulkInsertChunkSize) {
    const chunk = playerIds.slice(i, i + bulkInsertChunkSize)
    const rows = await tenantDB.all<{ id: string }[]>(
      `SELECT id FROM player WHERE id IN (${placeholders(chunk.length)})`,
      chunk
    )
    for (const row of rows) {
      existingPlayerIds.add(row.id)
    }
  }

  const rows: unknown[][] = []
  let rowNum = 0
  for (const record of records) {
    rowNum++
    const keys = Object.keys(record)
    if (keys.length !== 2) {
      throw new Error('row must have two columns ${record}')
    }

    const { player_id, score: scoreStr } = record
    if (!existingPlayerIds.has(player_id)) {
      // 存在しない参加者が含まれている
      throw new ErrorWithStatus(400, `player not found: ${player_id}`)
    }

    const score = parseInt(scoreStr, 10)
    if (isNaN(score)) {
      throw new ErrorWithStatus(400, `error parseInt: scoreStr=${scoreStr}`)
    }

    const id = await dispenseID()
    const now = unixNow()
    rows.push([id, viewer.tenantId, player_id, competitionId, score, rowNum, now, now])
  }

  // DELETEしたタイミングで参照が来ると空っぽのランキングになるので、トランザクションを張って入れ替える
  // (WALモードなので、他の接続からはコミットまで入れ替え前のスコアが見える)
  await withTenantWriteLock(viewer.tenantId, async () => {
    await tenantDB.exec('BEGIN IMMEDIATE')
    try {
      await tenantDB.run(
        'DELETE FROM player_score WHERE tenant_id = ? AND competition_id = ?',
        viewer.tenantId,
        competitionId
      )
      await bulkInsert(
        tenantDB,
        'player_score',
        ['id', 'tenant_id', 'player_id', 'competition_id', 'score', 'row_num', 'created_at', 'updated_at'],
        rows
      )
      await tenantDB.exec('COMMIT')
    } catch (error) {
      await tenantDB.exec('ROLLBACK')
      throw error
    }
  })
  invalidateRanking(viewer.tenantId, competitionId)

  return rows.length
}

// テナント管理者向けAPI
// GET /api/organizer/billing
// テナント内の課金レポートを取得する
app.get(
  '/api/organizer/billing',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RoleOrganizer, 'role organizer required')

    const reports = await withTenantDB(viewer.tenantId, async (tenantDB) => {
      const competitions = await listCompetitions(tenantDB, viewer.tenantId)
      return billingReportsByCompetitions(tenantDB, viewer.tenantId, competitions)
    })

    const data: BillingResult = {
      reports,
    }
    res.status(200).json({
      status: true,
      data,
    })
  })
)

function competitionsHandler(res: Response, competitions: CompetitionRow[]) {
  const data: CompetitionsResult = {
    competitions: competitions.map(toCompetitionDetail),
  }
  res.status(200).json({
    status: true,
    data,
  })
}

// テナント管理者向けAPI
// GET /api/organizer/competitions
// 大会の一覧を取得する
app.get(
  '/api/organizer/competitions',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RoleOrganizer, 'role organizer required')

    const competitions = await withTenantDB(viewer.tenantId, (tenantDB) => listCompetitions(tenantDB, viewer.tenantId))
    competitionsHandler(res, competitions)
  })
)

// 参加者向けAPI
// GET /api/player/player/:playerId
// 参加者の詳細情報を取得する
app.get(
  '/api/player/player/:playerId',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RolePlayer, 'role player required')

    const { playerId } = req.params
    if (!playerId) {
      throw new ErrorWithStatus(400, 'player_id is required')
    }

    const [p, competitions, pss] = await withTenantDB(viewer.tenantId, async (tenantDB) => {
      await authorizePlayer(tenantDB, viewer.playerId)

      const p = await retrievePlayer(tenantDB, playerId)
      if (!p) {
        throw new ErrorWithStatus(404, 'player not found')
      }

      const competitions = await tenantDB.all<CompetitionRow[]>(
        'SELECT * FROM competition WHERE tenant_id = ? ORDER BY created_at ASC',
        viewer.tenantId
      )
      const pss = await tenantDB.all<PlayerScoreRow[]>(
        'SELECT competition_id, score, row_num FROM player_score WHERE tenant_id = ? AND player_id = ?',
        viewer.tenantId,
        p.id
      )
      return [p, competitions, pss] as const
    })

    // 最後にCSVに登場したスコアを採用する = row_numが一番大きいもの
    const latestScores = new Map<string, PlayerScoreRow>()
    for (const ps of pss) {
      const latest = latestScores.get(ps.competition_id)
      if (!latest || latest.row_num < ps.row_num) {
        latestScores.set(ps.competition_id, ps)
      }
    }

    const psds: PlayerScoreDetail[] = []
    for (const comp of competitions) {
      const ps = latestScores.get(comp.id)
      if (!ps) {
        // 行がない = スコアが記録されてない
        continue
      }
      psds.push({
        competition_title: comp.title,
        score: ps.score,
      })
    }

    const data: PlayerResult = {
      player: toPlayerDetail(p),
      scores: psds,
    }
    res.status(200).json({
      status: true,
      data,
    })
  })
)

// 大会ごとのランキング(全順位)のキャッシュ
// スコアの入稿でのみ変わるので、入稿時に世代を進めて無効化する
// 計算中に入稿が挟まった場合は古い結果をキャッシュしないよう、計算開始時の世代と比較する
const rankingCache = new Map<string, CompetitionRank[]>()
const rankingGenerations = new Map<string, number>()

function rankingKey(tenantId: number, competitionId: string): string {
  return `${tenantId}:${competitionId}`
}

function invalidateRanking(tenantId: number, competitionId: string) {
  const key = rankingKey(tenantId, competitionId)
  rankingGenerations.set(key, (rankingGenerations.get(key) ?? 0) + 1)
  rankingCache.delete(key)
}

async function fetchRanking(tenantDB: Database, tenantId: number, competitionId: string): Promise<CompetitionRank[]> {
  const key = rankingKey(tenantId, competitionId)
  const cached = rankingCache.get(key)
  if (cached) {
    return cached
  }
  const generation = rankingGenerations.get(key) ?? 0

  // 最後にCSVに登場したスコアを採用する = 参加者ごとに row_num が一番大きいもの
  // (SQLite では MAX() と同時に取得した列は MAX() を取った行の値になる)
  const tmpRanks = await tenantDB.all<(CompetitionRank & { row_num: number })[]>(
    `SELECT ps.player_id, ps.score, ps.row_num, p.display_name AS player_display_name
    FROM (
      SELECT player_id, score, MAX(row_num) AS row_num FROM player_score
      WHERE tenant_id = ? AND competition_id = ? GROUP BY player_id
    ) ps JOIN player p ON p.id = ps.player_id`,
    tenantId,
    competitionId
  )

  tmpRanks.sort((a, b) => {
    if (a.score === b.score) {
      return a.row_num < b.row_num ? -1 : 1
    }
    return a.score > b.score ? -1 : 1
  })

  const ranks = tmpRanks.map((rank, index) => ({
    rank: index + 1,
    score: rank.score,
    player_id: rank.player_id,
    player_display_name: rank.player_display_name,
  }))

  if ((rankingGenerations.get(key) ?? 0) === generation) {
    rankingCache.set(key, ranks)
  }
  return ranks
}

// 参加者向けAPI
// GET /api/player/competition/:competitionId/ranking
// 大会ごとのランキングを取得する
app.get(
  '/api/player/competition/:competitionId/ranking',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RolePlayer, 'role player required')

    const { competitionId } = req.params
    if (!competitionId) {
      throw new ErrorWithStatus(400, 'competition_id is required')
    }

    const { rank_after: rankAfterStr } = req.query
    let rankAfter = 0
    if (rankAfterStr) {
      // 数値でない場合は先頭から返す
      rankAfter = parseInt(rankAfterStr.toString(), 10) || 0
    }
    const start = Math.max(rankAfter, 0)

    const [competition, allRanks] = await withTenantDB(viewer.tenantId, async (tenantDB) => {
      await authorizePlayer(tenantDB, viewer.playerId)

      const competition = await retrieveCompetition(tenantDB, competitionId)
      if (!competition) {
        throw new ErrorWithStatus(404, 'competition not found')
      }

      const now = unixNow()
      await adminDB.execute<OkPacket>(
        'INSERT INTO visit_history (player_id, tenant_id, competition_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [viewer.playerId, viewer.tenantId, competitionId, now, now]
      )

      return [competition, await fetchRanking(tenantDB, viewer.tenantId, competition.id)] as const
    })

    const data: CompetitionRankingResult = {
      competition: toCompetitionDetail(competition),
      ranks: allRanks.slice(start, start + 100),
    }
    res.status(200).json({
      status: true,
      data,
    })
  })
)

// 参加者向けAPI
// GET /api/player/competitions
// 大会の一覧を取得する
app.get(
  '/api/player/competitions',
  wrap(async (req: Request, res: Response) => {
    const viewer = await parseViewerWithRole(req, RolePlayer, 'role player required')

    const competitions = await withTenantDB(viewer.tenantId, async (tenantDB) => {
      await authorizePlayer(tenantDB, viewer.playerId)
      return listCompetitions(tenantDB, viewer.tenantId)
    })
    competitionsHandler(res, competitions)
  })
)

// 共通API
// GET /api/me
// JWTで認証した結果、テナントやユーザ情報を返す
app.get(
  '/api/me',
  wrap(async (req: Request, res: Response) => {
    const tenant = await retrieveTenantRowFromHeader(req)
    if (!tenant) {
      throw new ErrorWithStatus(500, 'tenant not found')
    }

    const td: TenantDetail = {
      name: tenant.name,
      display_name: tenant.display_name,
    }

    const viewer = await parseViewer(req)
    if (viewer.role === RoleAdmin || viewer.role === RoleOrganizer) {
      const data: MeResult = {
        tenant: td,
        me: null,
        role: viewer.role,
        logged_in: true,
      }
      return res.status(200).json({
        status: true,
        data,
      })
    }

    const p = await withTenantDB(viewer.tenantId, (tenantDB) => retrievePlayer(tenantDB, viewer.playerId))
    if (!p) {
      const data: MeResult = {
        tenant: td,
        me: null,
        role: RoleNone,
        logged_in: false,
      }
      return res.status(200).json({
        status: true,
        data,
      })
    }

    const data: MeResult = {
      tenant: td,
      me: toPlayerDetail(p),
      role: viewer.role,
      logged_in: true,
    }
    // NOTE: 既存のレスポンスとの互換性のため、キー名 "statu" はそのままにしている
    return res.status(200).json({
      statu: true,
      data,
    })
  })
)

// ベンチマーカー向けAPI
// POST /initialize
// ベンチマーカーが起動したときに最初に呼ぶ
// データベースの初期化などが実行されるため、スキーマを変更した場合などは適宜改変すること
app.post(
  '/initialize',
  wrap(async (req: Request, res: Response, _next: NextFunction) => {
    try {
      // テナントDBのファイルを置き換えるので、開いている接続とプロセス内のキャッシュを破棄する
      await closeIdleTenantDBs()
      tenantCache.clear()
      billingReportCache.clear()
      rankingCache.clear()
      rankingGenerations.clear()
      await exec(initializeScript)
      resetIDBlock()

      const data: InitializeResult = {
        lang: 'node',
      }
      res.status(200).json({
        status: true,
        data,
      })
    } catch (error) {
      throw new ErrorWithStatus(500, `initialize failed: ${error}`)
    }
  })
)

// エラー処理関数
app.use((err: ErrorWithStatus, req: Request, res: Response, _next: NextFunction) => {
  const status = err.status ?? 500
  console.error('error occurred: status=' + status + ' reason=' + err.message)
  res.status(status).json({
    status: false,
  })
})

const port = getEnv('SERVER_APP_PORT', '3000')

// 接続の受け付け(accept)だけを行うプライマリプロセスと、リクエストを処理するワーカープロセス1つで動かす
// ワーカーが忙しいと accept が遅れて listen backlog があふれ、接続がリセットされてしまうので、受け付けを別プロセスに任せる
// (キャッシュや書き込みロックはプロセス内で持っているので、ワーカーは必ず1つにすること)
if (cluster.isPrimary) {
  console.log('starting isuports server on :' + port + ' ...')
  cluster.fork()
  cluster.on('exit', (worker, code, signal) => {
    console.error(`worker exited: code=${code} signal=${signal}`)
    process.exit(1)
  })
} else {
  const server = app.listen(port)
  // リバースプロキシとの keepalive 接続を、プロキシ側より先に切らないようにする
  // (Node.js 18 では headersTimeout / requestTimeout の定期チェックで使用中の keepalive 接続が切られることがあるので無効にし、
  //  タイムアウトはリバースプロキシ側に任せる)
  server.keepAliveTimeout = 65 * 1000
  server.headersTimeout = 0
  server.requestTimeout = 0
}
