const startMarkers = new WeakMap<(source: string) => number | void, string>()

/** Let a lexer skip suffix searches for markers absent from its entire input. */
export function createMarkdownTokenizerStart(marker: string, lineStart = false) {
  const start = (source: string): number => {
    let position = source.indexOf(marker)
    while (lineStart && position > 0 && !'\n\r\u2028\u2029'.includes(source[position - 1])) {
      position = source.indexOf(marker, position + marker.length)
    }
    return position
  }
  startMarkers.set(start, marker)
  return start
}

export function getMarkdownTokenizerStartMarker(start: (source: string) => number | void) {
  return startMarkers.get(start)
}
