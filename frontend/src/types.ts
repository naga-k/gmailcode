export interface EmailSummary {
  id: string
  threadId: string
  from: string
  fromEmail: string
  subject: string
  date: string
  snippet: string
  labels: string[]
  hasUnsub: boolean
  unsubHeader: string
}

export interface EmailFull extends EmailSummary {
  to: string
  body: string
  bodyHtml?: string
}

export interface LabelCounts {
  [id: string]: { total: number; unread: number }
}

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
}

export type TriageCategory =
  | 'newsletter'
  | 'promotion'
  | 'social'
  | 'alert'
  | 'transactional'
  | 'personal'
  | 'system'
  | 'other'

export interface TriageDecision {
  decision: 'trash' | 'keep' | 'review'
  category: TriageCategory
  reason: string
  from: string
  subject: string
}
