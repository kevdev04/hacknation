/**
 * The project as a graph.
 *
 * A session is not a list of questions. The scientist asks something, reads the
 * answer, asks a follow-up *from* that answer — and then, often, goes back to an
 * earlier answer and asks something different instead. That second move is a
 * bifurcation, and a flat list throws away the one thing that made it
 * interesting: which answer it came from.
 *
 * So every question is a node with a parent, and the panel draws the tree the
 * way a commit graph does. Two questions asked from the same answer sit on
 * different lanes and stay visibly separate for the rest of the session.
 *
 * Two pointers, borrowed from the same place the metaphor came from:
 *
 *   `head`   the node whose answer is on screen. Checking out a node moves it.
 *   `branch` where the next question will attach. It follows `head` unless the
 *            reviewer deliberately pins it somewhere else — which is how a
 *            bifurcation is made on purpose rather than by accident.
 */

export type NodeStatus = "running" | "answered" | "failed" | "empty";

export interface HistoryNode {
  /** The lab's `query_id`, or `exp-NNN` for a node restored from the gate. */
  id: string;
  parent: string | null;
  query: string;
  /** Seconds since the session started. */
  at: number;
  status: NodeStatus;
  headline?: string;
  kind?: string;
  latency_ms?: number;
  verdict?: string | null;
  /** Index into the viewer's answer list, once this node has an answer. */
  answer?: number;
  /** Set when this node is kept on the gate, to the experiment id. */
  saved?: string;
  /** True for nodes restored from the gate rather than asked this session. */
  restored?: boolean;
}

/** One drawn row: a node, which lane it sits in, and the edges leaving it. */
export interface GraphRow {
  node: HistoryNode;
  lane: number;
  /** Row index, 0 at the top. Newest first, as a commit graph reads. */
  row: number;
  /** The parent's row and lane, for the connector. null for a root. */
  parentRow: number | null;
  parentLane: number | null;
  isHead: boolean;
  isBranch: boolean;
}

export interface Graph {
  rows: GraphRow[];
  /** How many lanes are in use — the gutter width the panel must reserve. */
  lanes: number;
}

/** Beyond this the gutter costs more than the branching tells you. */
const MAX_LANES = 6;

/** The part of a kept experiment the tree needs. */
export interface RestoredRecord {
  experiment_id: string;
  query_id?: string | null;
  parent_id?: string | null;
  query: string;
  headline: string;
  kind: string;
  saved_at?: string | null;
}

export class History {
  private nodes = new Map<string, HistoryNode>();
  /** Chronological: the order lanes are assigned in. */
  private order: string[] = [];

  /** The node whose answer is on screen. */
  head: string | null = null;
  /** Where the next question attaches. Null means "follow head". */
  private pinned: string | null = null;

  get branch(): string | null {
    return this.pinned ?? this.head;
  }

  /** True when the next question will deliberately fork an earlier answer. */
  get isPinned(): boolean {
    return this.pinned !== null && this.pinned !== this.head;
  }

  get size(): number {
    return this.nodes.size;
  }

  get(id: string | null): HistoryNode | undefined {
    return id ? this.nodes.get(id) : undefined;
  }

  all(): HistoryNode[] {
    return this.order.map((id) => this.nodes.get(id)!);
  }

  /** Add a question. Its parent is wherever the branch pointer is standing. */
  add(node: Omit<HistoryNode, "parent"> & { parent?: string | null }): HistoryNode {
    const parent = node.parent !== undefined ? node.parent : this.branch;
    const full: HistoryNode = { ...node, parent: parent ?? null };
    this.nodes.set(full.id, full);
    this.order.push(full.id);
    this.head = full.id;
    // Asking consumes the pin: the fork has been made, and the next question
    // continues from it rather than forking the same answer again.
    this.pinned = null;
    return full;
  }

  update(id: string, patch: Partial<HistoryNode>): void {
    const node = this.nodes.get(id);
    if (node) Object.assign(node, patch);
  }

  /** Put this node's answer on screen. */
  checkout(id: string): HistoryNode | undefined {
    const node = this.nodes.get(id);
    if (!node) return undefined;
    this.head = id;
    this.pinned = null;
    return node;
  }

  /** Pin the next question to this node, forking it. Pinning head clears it. */
  pin(id: string | null): void {
    this.pinned = id === this.head ? null : id;
  }

  /** How many questions were asked directly from this one. */
  childCount(id: string): number {
    let n = 0;
    for (const node of this.nodes.values()) if (node.parent === id) n++;
    return n;
  }

  /** The path from a node back to its root, nearest first. */
  ancestry(id: string): HistoryNode[] {
    const out: HistoryNode[] = [];
    const seen = new Set<string>();
    let cursor = this.nodes.get(id)?.parent ?? null;
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = this.nodes.get(cursor);
      if (!node) break;
      out.push(node);
      cursor = node.parent;
    }
    return out;
  }

  /**
   * Rebuild the tree from records kept outside the session.
   *
   * Nothing here trusts the order the records arrive in. The gate stamps
   * `saved_at` to the second and returns newest first, so a handful of saves
   * made in the same second come back with children ahead of their parents;
   * placing them in that order would orphan every one of them. Each record
   * pulls its own parent in first instead.
   *
   * `store` is handed each record's kept result and returns wherever the
   * caller put it, so the node can be checked out later.
   */
  restore(
    records: RestoredRecord[],
    store: (record: RestoredRecord) => number | undefined,
  ): void {
    const byId = new Map<string, RestoredRecord>();
    for (const r of records) byId.set(r.query_id ?? r.experiment_id, r);

    const placing = new Set<string>();
    const place = (id: string): void => {
      if (this.nodes.has(id) || placing.has(id)) return;
      placing.add(id); // also stops a cycle in bad data from recursing forever

      const r = byId.get(id);
      if (!r) return;

      const parent = r.parent_id ?? null;
      const linked = parent != null && byId.has(parent);
      if (linked) place(parent!);

      this.add({
        id,
        // A parent that was never saved is gone; this node becomes a root
        // rather than hanging off an edge that leads nowhere.
        parent: linked ? parent : null,
        query: r.query,
        at: 0,
        status: "answered",
        headline: r.headline,
        kind: r.kind,
        saved: r.experiment_id,
        restored: true,
        answer: store(r),
      });
    };

    // Oldest first so lanes are assigned in the order the work happened. The
    // ids are sequential, which is the only tie-break left at second
    // resolution.
    const ordered = [...byId.keys()].sort((a, b) => {
      const ra = byId.get(a)!;
      const rb = byId.get(b)!;
      return (
        (ra.saved_at ?? "").localeCompare(rb.saved_at ?? "") ||
        ra.experiment_id.localeCompare(rb.experiment_id)
      );
    });
    for (const id of ordered) place(id);

    // Restoring is not a question: nothing should be left checked out from it.
    this.head = null;
  }

  /**
   * Lay the tree out in lanes, the way `git log --graph` does.
   *
   * A node continues its parent's lane if it is the first child; every later
   * child — the bifurcation — takes a free lane of its own and keeps it. Lanes
   * are assigned in the order questions were asked, then the rows are flipped
   * so the newest sits at the top where it does not need scrolling to.
   */
  layout(): Graph {
    const lane = new Map<string, number>();
    /** Which node currently owns each lane, i.e. whose child continues it. */
    const owner: (string | null)[] = [];
    /** Chronological index of the last node placed in each lane. */
    const lastUsed: number[] = [];

    /**
     * Take a lane for a node whose parent sits at chronological index `since`.
     *
     * A free lane is only safe if nothing was drawn in it between the parent
     * and here — otherwise the connector would run straight through somebody
     * else's dot and two unrelated questions would look like one chain. A root
     * draws no connector, so any free lane will do.
     */
    const claim = (since: number | null): number => {
      for (let l = 0; l < owner.length; l++) {
        if (owner[l] !== null) continue;
        if (since !== null && lastUsed[l] !== undefined && lastUsed[l] > since) continue;
        return l;
      }
      if (owner.length < MAX_LANES) {
        owner.push(null);
        return owner.length - 1;
      }
      // Out of lanes: share the last one rather than widening the gutter.
      return MAX_LANES - 1;
    };

    // How many questions came off each node, so a lane can be handed back the
    // moment its branch is a dead end rather than held for the whole session.
    const children = new Map<string, number>();
    for (const node of this.nodes.values()) {
      if (node.parent != null) children.set(node.parent, (children.get(node.parent) ?? 0) + 1);
    }
    const indexOf = new Map<string, number>();
    this.order.forEach((id, i) => indexOf.set(id, i));

    this.order.forEach((id, i) => {
      const node = this.nodes.get(id)!;
      const parentLane = node.parent != null ? lane.get(node.parent) : undefined;
      let own: number;
      if (parentLane !== undefined && owner[parentLane] === node.parent) {
        own = parentLane; // first child: carry the line straight down
      } else {
        // A root, or a fork: start a lane that nothing else is drawn through.
        own = claim(node.parent != null ? (indexOf.get(node.parent) ?? null) : null);
      }
      // Hold the lane only while something is still going to continue it.
      owner[own] = (children.get(id) ?? 0) > 0 ? id : null;
      lastUsed[own] = i;
      lane.set(id, own);
    });

    const total = this.order.length;
    const rowOf = new Map<string, number>();
    this.order.forEach((id, i) => rowOf.set(id, total - 1 - i));

    const rows: GraphRow[] = this.order.map((id) => {
      const node = this.nodes.get(id)!;
      return {
        node,
        lane: lane.get(id) ?? 0,
        row: rowOf.get(id)!,
        parentRow: node.parent != null ? (rowOf.get(node.parent) ?? null) : null,
        parentLane: node.parent != null ? (lane.get(node.parent) ?? null) : null,
        isHead: id === this.head,
        isBranch: id === this.branch && this.isPinned,
      };
    });

    rows.sort((a, b) => a.row - b.row);
    return { rows, lanes: Math.max(1, owner.length) };
  }
}
