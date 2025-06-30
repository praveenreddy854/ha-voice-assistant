export interface HassState {
  entity_id: string;
  state: string;
  attributes: {
    friendly_name?: string;
    description?: string;
    [key: string]: any;
  };
}

export interface HassServiceCommandBody {
  url_path: string;
  entity_id: string;
}
