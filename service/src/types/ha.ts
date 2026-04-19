export interface HassState {
  entity_id: string;
  state: string;
  attributes: {
    friendly_name?: string;
    description?: string;
    [key: string]: any;
  };
  last_changed?: string;
  last_updated?: string;
  context?: {
    id?: string;
    parent_id?: string | null;
    user_id?: string | null;
    [key: string]: any;
  };
}

export interface HassServiceCommand {
  url_path: string;
  entity_id: string;
  service_data?: {
    media_content_type?: string;
    media_content_id?: string;
    command?: string;
    num_repeats?: number;
    delay_secs?: number;
    [key: string]: any;
  };
}

// Support both single command and array of commands
export type HassServiceCommandBody = HassServiceCommand | HassServiceCommand[];
