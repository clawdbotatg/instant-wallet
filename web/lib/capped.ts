/** A Map that never holds more than `max`: a new key pushes out the one written longest ago. For server caches. */
export class Capped<K, V> extends Map<K, V> {
  constructor(private max: number) {
    super();
  }
  set(k: K, v: V) {
    super.delete(k); // written again: newest again
    super.set(k, v);
    while (this.size > this.max) super.delete(this.keys().next().value as K);
    return this;
  }
}
