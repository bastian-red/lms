export interface Message {
  to: string;
  subject: string;
  text: string;
}

export interface Channel {
  name: string;
  send(message: Message): Promise<void>;
}
