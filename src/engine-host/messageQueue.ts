/**
 * A push-based async iterable used as the streaming input of a Claude Agent SDK query.
 * The query stays alive between turns; each pushed message starts a new turn.
 */
export class MessageQueue<Item> implements AsyncIterable<Item> {
  private readonly bufferedItems: Item[] = []
  private readonly waitingConsumers: ((result: IteratorResult<Item>) => void)[] = []
  private ended = false

  push(item: Item): void {
    if (this.ended) throw new Error('La file de messages est fermée.')
    const consumer = this.waitingConsumers.shift()
    if (consumer) consumer({ value: item, done: false })
    else this.bufferedItems.push(item)
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    for (const consumer of this.waitingConsumers.splice(0)) consumer({ value: undefined, done: true })
  }

  get isEnded(): boolean {
    return this.ended
  }

  [Symbol.asyncIterator](): AsyncIterator<Item> {
    return {
      next: (): Promise<IteratorResult<Item>> => {
        const buffered = this.bufferedItems.shift()
        if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waitingConsumers.push(resolve))
      },
      return: (): Promise<IteratorResult<Item>> => {
        this.end()
        return Promise.resolve({ value: undefined, done: true })
      }
    }
  }
}
