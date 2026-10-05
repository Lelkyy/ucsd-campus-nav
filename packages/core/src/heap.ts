/** Binary min-heap of (node, priority) with lazy deletion handled by the caller. */
export class MinHeap {
  private nodes: number[] = [];
  private prios: number[] = [];

  get size(): number {
    return this.nodes.length;
  }

  push(node: number, prio: number): void {
    const { nodes, prios } = this;
    let i = nodes.length;
    nodes.push(node);
    prios.push(prio);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (prios[parent] <= prio) break;
      nodes[i] = nodes[parent];
      prios[i] = prios[parent];
      i = parent;
    }
    nodes[i] = node;
    prios[i] = prio;
  }

  pop(): number {
    const { nodes, prios } = this;
    const top = nodes[0];
    const lastNode = nodes.pop()!;
    const lastPrio = prios.pop()!;
    const len = nodes.length;
    if (len > 0) {
      let i = 0;
      while (true) {
        const l = 2 * i + 1;
        if (l >= len) break;
        const r = l + 1;
        const c = r < len && prios[r] < prios[l] ? r : l;
        if (prios[c] >= lastPrio) break;
        nodes[i] = nodes[c];
        prios[i] = prios[c];
        i = c;
      }
      nodes[i] = lastNode;
      prios[i] = lastPrio;
    }
    return top;
  }
}
