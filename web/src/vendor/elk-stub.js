// Grillado doesn't ship elkjs (EPL-2.0, ~1.4 MB). Mermaid only loads it for diagrams that ask for
// `layout: elk`; those show Mermaid's error and their source instead. The default layout works.
export default class ELK {
  constructor() {
    throw new Error("The ELK layout isn't available in Grillado. Use the default (dagre) layout.");
  }
}
