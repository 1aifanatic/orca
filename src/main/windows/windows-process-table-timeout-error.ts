/** A read missed its deadline, or was refused because an earlier one has not returned yet. */
export class WindowsProcessTableTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WindowsProcessTableTimeoutError'
  }
}
