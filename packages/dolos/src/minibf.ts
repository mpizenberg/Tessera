/**
 * A Dolos node's mini-Blockfrost API. Local, so no retry or rate limit:
 * a failed request is an error, and only 404 is an answer (the entity is
 * unknown to the node).
 */
export class Minibf {
  constructor(readonly url: string) {}

  /** The route's JSON, or null when the node answers 404. */
  async find<T>(path: string): Promise<T | null> {
    const res = await fetch(this.url + path);
    if (res.status === 404) return null;
    if (!res.ok)
      throw new Error(`minibf ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  async get<T>(path: string): Promise<T> {
    const found = await this.find<T>(path);
    if (found === null) throw new Error(`minibf ${path}: 404`);
    return found;
  }

  /** Every page of a list route, `count` rows each. */
  async all<T>(path: string, count = 100): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const rows: T[] = [];
    for (let page = 1; ; page++) {
      const batch =
        (await this.find<T[]>(`${path}${sep}count=${count}&page=${page}`)) ??
        [];
      rows.push(...batch);
      if (batch.length < count) return rows;
    }
  }
}

export interface BlockRow {
  hash: string;
  height: number;
  slot: number;
  epoch: number;
  epoch_slot: number;
  time: number;
}

/**
 * The last block of `epoch`, on a node that has reached `epoch + 1`: the one
 * below that epoch's first block.
 */
export async function lastBlockOf(
  node: Minibf,
  epoch: number,
): Promise<BlockRow> {
  const [first] =
    (await node.find<string[]>(`/epochs/${epoch + 1}/blocks?count=1&page=1`)) ??
    [];
  if (first === undefined)
    throw new Error(
      `the node at ${node.url} has not reached epoch ${epoch + 1}`,
    );
  const next = await node.get<BlockRow>(`/blocks/${first}`);
  const last = await node.get<BlockRow>(`/blocks/${next.height - 1}`);
  if (last.epoch !== epoch)
    throw new Error(
      `block ${last.height} is in epoch ${last.epoch}, not ${epoch}`,
    );
  return last;
}
