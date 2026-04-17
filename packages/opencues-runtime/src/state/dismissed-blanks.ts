export class DismissedBlanks {
  private _positions = new Set<number>();

  has(offset: number): boolean {
    return this._positions.has(offset);
  }

  add(offset: number): void {
    this._positions.add(offset);
  }

  delete(offset: number): void {
    this._positions.delete(offset);
  }

  clear(): void {
    this._positions.clear();
  }
}
