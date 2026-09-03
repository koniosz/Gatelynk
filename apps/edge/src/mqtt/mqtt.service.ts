import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import * as net from 'net'

// Dynamic import of aedes (ESM-compatible)
let Aedes: any
try { Aedes = require('aedes') } catch { /* optional */ }

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MqttService.name)
  private broker: any = null
  private server: net.Server | null = null
  private readonly MQTT_PORT = 1883

  private subscribers: Map<string, ((topic: string, payload: Buffer) => void)[]> = new Map()

  onModuleInit() {
    if (!Aedes) {
      this.logger.warn('aedes not installed — local MQTT broker disabled')
      return
    }

    this.broker = Aedes()
    this.server = net.createServer(this.broker.handle.bind(this.broker))

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        this.logger.warn(`MQTT port ${this.MQTT_PORT} already in use — broker disabled (another instance running)`)
        this.server?.close()
        this.server = null
        this.broker?.close()
        this.broker = null
      } else {
        this.logger.error(`MQTT server error: ${err.message}`)
      }
    })

    this.server.listen(this.MQTT_PORT, '127.0.0.1', () => {
      this.logger.log(`Local MQTT broker listening on mqtt://127.0.0.1:${this.MQTT_PORT}`)
    })

    this.broker.on('publish', (packet: any, _client: any) => {
      if (!packet.topic || packet.topic.startsWith('$')) return
      const handlers = this.subscribers.get(packet.topic) ?? []
      handlers.forEach((h) => h(packet.topic, packet.payload))
      this.logger.debug(`MQTT <- ${packet.topic}: ${packet.payload?.toString()?.slice(0, 80)}`)
    })

    this.broker.on('client', (client: any) => {
      this.logger.log(`MQTT client connected: ${client?.id}`)
    })

    this.broker.on('clientDisconnect', (client: any) => {
      this.logger.log(`MQTT client disconnected: ${client?.id}`)
    })
  }

  onModuleDestroy() {
    this.broker?.close()
    this.server?.close()
  }

  // ── Subscribe to topic ───────────────────────────────────────────────────────
  subscribe(topic: string, handler: (topic: string, payload: Buffer) => void) {
    const existing = this.subscribers.get(topic) ?? []
    this.subscribers.set(topic, [...existing, handler])
  }

  // ── Publish to local broker ──────────────────────────────────────────────────
  publish(topic: string, payload: string | Buffer) {
    if (!this.broker) return
    this.broker.publish(
      {
        cmd: 'publish',
        qos: 0,
        topic,
        payload: Buffer.isBuffer(payload) ? payload : Buffer.from(payload),
        retain: false,
        dup: false,
      },
      () => {},
    )
  }

  getBrokerInfo() {
    return {
      running: !!this.broker,
      port: this.MQTT_PORT,
      host: '127.0.0.1',
    }
  }
}
