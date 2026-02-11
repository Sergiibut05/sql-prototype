export interface GraphNode {
  id: string;
  name: string;
  val?: number;
  columns?: string[];
  schema?: string;
  isSubquery?: boolean;
  // Runtime positions set by force layout
  x?: number;
  y?: number;
  z?: number;
}

export interface GraphLink {
  source: string | any;
  target: string | any;
  sourceColumn?: string;
  targetColumn?: string;
  type?: 'inner' | 'left' | 'right' | 'full';
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}
