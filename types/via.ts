export interface Response {
  [key: string]: RawViaTrain;
}

export interface RawViaTrain {
  lat: number
  lng: number
  speed: number
  direction: number
  poll: string
  departed: boolean
  arrived: boolean
  from: string
  to: string
  instance: string
  pollMin: number
  pollRadius: number
  times: RawViaTime[]
}

export interface RawViaTime {
  station: string
  code: string
  estimated: string
  scheduled: string
  eta: string
  departure: RawViaDeparture
  diff: string
  diffMin: number
  arrival?: RawViaArrival
}

export interface RawViaDeparture {
  estimated: string
  scheduled: string
}

export interface RawViaArrival {
  estimated: string
  scheduled: string
}
