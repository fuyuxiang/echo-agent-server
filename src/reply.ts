export interface Envelope<T> {
  code: number
  msg: string
  data: T
}

export function ok<T>(data: T): Envelope<T> {
  return { code: 0, msg: 'ok', data }
}

export function fail(code: number, msg: string): Envelope<null> {
  return { code, msg, data: null }
}
