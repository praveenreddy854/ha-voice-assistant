export interface Message {
  sender: "user" | "assistant";
  text: string;
}
