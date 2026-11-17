import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle } from '@fluentui/react-components';
import { ArrowUpRightRegular } from '@fluentui/react-icons';
import type { AgentEvent, AgentRouteMode } from './api';

export const routeModes: Record<AgentRouteMode, string> = {auto:'自动',single:'单模型',group:'分组'};
export const routeReasons: Record<string, string> = {
  'focused-task':'任务适合单模型执行', 'global-single':'全局单模型', 'global-group':'全局分组',
  'selected-single':'本次指定单模型', 'selected-group':'本次指定模型组',
  'parallel-work':'有可并行的子任务', 'independent-review':'需要独立复核',
  'no-default-group':'未设置默认模型组', 'escalated':'从单模型升级到分组',
};

export const agentStatuses: Record<string, string> = {
  running: '运行中', paused: '已暂停', 'awaiting-review': '等待验收', completed: '已完成',
  failed: '失败', cancelled: '已取消', ready: '就绪', waiting: '等待',
  submitted: '已提交', approved: '已审查', planning: '制定计划', working: '分工执行', 'handed-off':'已交接',
  reviewing: '独立审查', queued: '等待依赖', active: '执行中', reported: '已交付',
};

const eventTitles: Record<string, string> = {
  'task-control': '任务控制审计',
  created: '任务创建', state: '任务状态', routing: '模型调度', recovered: '任务恢复', 'inference-start': '模型推理',
  'inference-stream': '模型推理', output: '模型推理', message: '协作消息', review: '审查',
  'tool-start': '工具操作', 'tool-result': '工具操作', 'tool-error': '工具操作',
  compaction: '上下文压缩', plan: '任务分配', 'plan-fallback': '备用计划',
  assignment: '子任务开始', report: '交付报告', 'parallel-dispatch': '并行调度',
  'user-accepted': '人工验收', 'auto-accepted': '自动验收', 'memory-saved': '已保存记忆', 'memory-skipped': '记忆未保存',
};
const fieldTitles: Record<string, string> = {
  action: '控制操作', source: '操作来源', caller: '调用会话指纹', owner: '归属会话指纹', ownerSource: '任务来源', reason: '操作原因', allowed: '归属校验通过', tool: '调用接口', taskId: '任务 ID', workspaceId: '工作区 ID',
  name: '工具名称', args: '调用参数', text: '工具返回', error: '错误',
  message: '消息内容', content: '模型输出', reasoning: '模型返回的思考内容', summary: '摘要',
  decision: '审查决定', reasoningConfig: '请求的思考参数', reasoningEvidence: '响应证据',
  status: '状态', goal: '任务目标', assignments: '任务分配', dependsOn: '前置任务',
  profileId: '模型配置', estimatedTokens: '预估输入 Token', to: '接收成员',
  ok: '执行成功', images: '返回截图数', checkpoint: '检查点内容', members: '参与成员',
  permissions: '授权范围', groupId: '模型组 ID', writer: '执行者', reviewers: '审查者',
  step: '推理轮次', callId: '调用 ID',
};
const time = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
export function formatAgentTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : time.format(date);
}
const comparison = (e: AgentEvent) => e.agent ?? '';
const family = (kind: string) => kind.startsWith('tool-') ? 'tool'
  : kind.startsWith('inference-') || kind === 'output' ? 'inference' : kind;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
export type FlowCard = { id: number; actor: string; family: string; events: AgentEvent[] };

export function appendFlowCards(previous: FlowCard[], events: AgentEvent[]): FlowCard[] {
  const cards = [...previous];
  for (const event of events) {
    const category = family(event.kind);
    const actor = comparison(event);
    const followsStart = ['inference-stream', 'output', 'tool-result', 'tool-error'].includes(event.kind);
    let at = -1;
    if (followsStart) {
      for (let index = cards.length - 1; index >= 0; index--) {
        const card = cards[index];
        if (card.actor !== actor || card.family !== category) continue;
        const first = card.events[0];
        const last = card.events[card.events.length - 1];
        const matches = category === 'tool'
          ? last.kind === 'tool-start' && (event.callId && first.callId ? event.callId === first.callId : event.name === first.name)
          : last.kind !== 'output' && (first.step == null || event.step == null || event.step === first.step);
        if (matches) { at = index; break; }
      }
    }
    if (at < 0) {
      cards.push({ id: event.seq, actor, family: category, events: [event] });
      continue;
    }
    const card = cards[at];
    // Stream events are cumulative. Keep the latest snapshot until the final response is recorded.
    cards[at] = { ...card, events: [...card.events.filter(e => e.kind !== 'inference-stream'), event] };
  }
  return cards;
}

export type FlowLane = {
  id: string;
  name: string;
  role: string;
  tone: 'runtime' | 'lead' | 'execution' | 'review' | 'member';
};

function describe(card: FlowCard, names: Map<string, string>) {
  const first = card.events[0];
  const last = card.events[card.events.length - 1];
  const get = (key: string) => text(last[key]) || text(first[key]);
  let title = eventTitles[first.kind] || first.kind;
  let preview = get('content') || get('summary') || get('goal') || get('message') || get('text') || get('error');
  if (card.family === 'inference') {
    preview ||= last.kind === 'output' ? '已返回响应，查看详情确认输出和参数' : '正在等待模型输出';
  } else if (card.family === 'tool') {
    title = get('name') || title;
    preview = get('error') || get('text') || (last.kind === 'tool-start' ? '等待工具返回' : '工具已返回');
  } else if (first.kind === 'message' && get('to')) {
    title = '发送给 ' + (names.get(get('to')) ?? get('to'));
  } else if (first.kind === 'state') {
    preview ||= agentStatuses[get('status')] || get('status');
  } else if (first.kind === 'task-control') {
    const actions: Record<string,string> = {cancel:'取消',pause:'暂停',resume:'恢复',accept:'验收'};
    const sources: Record<string,string> = {'local-ui':'本机工作台',mcp:'上游模型',internal:'内部运行时'};
    title = (actions[get('action')] || get('action')) + (last.ok===false?'被拒绝 / 失败':'操作记录');
    preview = [sources[get('source')] || get('source'),get('reason'),get('error')].filter(Boolean).join(' · ');
  } else if (first.kind === 'routing') {
    const mode = get('mode') as AgentRouteMode;
    preview = [routeModes[mode], routeReasons[get('reason')], get('detail')].filter(Boolean).join(' · ');
  } else if (first.kind === 'plan' && first.assignments && typeof first.assignments === 'object') {
    preview ||= '已分配 ' + Object.keys(first.assignments).length + ' 项工作';
  } else if (first.kind === 'parallel-dispatch' && Array.isArray(first.members)) {
    preview ||= first.members.map(id => names.get(String(id)) || String(id)).join(' · ');
  }
  const failure = last.kind === 'tool-error' || last.ok === false || last.status === 'failed';
  return { title, preview: preview.slice(0, 240), failure };
}

function FlowLink({ from, to }: { from: number; to: number }) {
  return <div className="agent-flow-link" aria-hidden="true">
    <i style={{ left: from + '%' }} />
    <b style={{ left: Math.min(from, to) + '%', width: Math.abs(from - to) + '%' }} />
    <em style={{ left: to + '%' }} />
  </div>;
}

function StreamText({value}: {value: string}) {
  const node=useRef<HTMLPreElement>(null);
  const position=useRef({top:0,follow:false});
  useLayoutEffect(()=>{
    const el=node.current;
    if(el)el.scrollTop=position.current.follow ? el.scrollHeight : position.current.top;
  },[value]);
  return <pre ref={node} style={{overflowAnchor:'none'}} onScroll={e=>{
    const el=e.currentTarget;
    position.current={top:el.scrollTop,follow:el.scrollHeight-el.clientHeight>0&&el.scrollHeight-el.clientHeight-el.scrollTop<=12};
  }}>{value}</pre>;
}

function FlowDetail({ card, lane, title, onClose }: { card: FlowCard; lane: FlowLane; title: string; onClose: () => void }) {
  return <Dialog open onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
    <DialogSurface className="agent-dialog agent-flow-detail">
      <DialogBody>
        <DialogTitle>{title}</DialogTitle>
        <DialogContent>
          <p className="agent-flow-detail-meta">{lane.name} · {lane.role}</p>
          {card.events.map(event => {
            const fields = Object.entries(event).filter(([key, value]) =>
              !['seq', 'at', 'agent', 'kind'].includes(key) && value != null && value !== '');
            return <section className="agent-flow-detail-section" key={event.kind==='inference-stream'||event.kind==='output'?'inference-response':event.seq}>
              <h4>{eventTitles[event.kind] || event.kind} <time>{formatAgentTime(event.at)}</time></h4>
              {fields.map(([key, value]) => <div className="agent-flow-field" key={key}>
                <strong>{fieldTitles[key] || key}</strong>
                <StreamText value={typeof value === 'string' ? value : JSON.stringify(value, null, 2)}/>
              </div>)}
            </section>;
          })}
        </DialogContent>
        <DialogActions><Button onClick={onClose}>关闭</Button></DialogActions>
      </DialogBody>
    </DialogSurface>
  </Dialog>;
}

const pageSize = 64;
export function AgentFlow({ lanes, cards }: { lanes: FlowLane[]; cards: FlowCard[] }) {
  const [earlier, showEarlier] = useState(pageSize);
  const [openId, setOpenId] = useState<number>();
  const laneById = useMemo(() => new Map(lanes.map((lane, index) => [lane.id, { lane, index }])), [lanes]);
  const names = useMemo(() => new Map(lanes.map(lane => [lane.id, lane.name])), [lanes]);
  const shown = cards.slice(-earlier);
  const selected = cards.find(card => card.id === openId);
  const selectedLane = selected ? (laneById.get(selected.actor)?.lane ?? lanes[0]) : null;
  const laneIndex = (card: FlowCard) => laneById.get(card.actor)?.index ?? 0;
  const lanePosition = (card: FlowCard) => (laneIndex(card) + .5) / lanes.length * 100;
  const cols = 'repeat(' + lanes.length + ', minmax(0, 1fr))';
  return <>
    {shown.length < cards.length && <Button size="small" onClick={() => showEarlier(count => count + pageSize)}>
      查看更早的节点（剩余 {cards.length - shown.length}）
    </Button>}
    <div className="agent-flow-scroll" aria-label="按角色分列的任务流程">
      <div className="agent-flow-board" style={{ minWidth: lanes.length * 158 }}>
        <div className="agent-flow-lanes" style={{ gridTemplateColumns: cols }}>
          {lanes.map(lane => <div className={'agent-flow-lane is-' + lane.tone} key={lane.id} title={lane.name}>
            <span>{lane.role}</span><strong>{lane.name}</strong>
          </div>)}
        </div>
        {shown.map((card, index) => {
          const lane = laneById.get(card.actor)?.lane ?? lanes[0];
          const detail = describe(card, names);
          const previous = shown[index - 1];
          return <div key={card.id}>
            {previous && <FlowLink from={lanePosition(previous)} to={lanePosition(card)} />}
            <div className="agent-flow-row" style={{ gridTemplateColumns: cols }}>
              <button type="button" data-flow-card={card.family}
                className={'agent-flow-node is-' + lane.tone + (detail.failure ? ' has-error' : '')}
                style={{ gridColumn: laneIndex(card) + 1 }} onClick={() => setOpenId(card.id)}>
                <span className="agent-flow-node-head"><strong>{detail.title}</strong><ArrowUpRightRegular /></span>
                {detail.preview && <span className="agent-flow-preview">{detail.preview}</span>}
                <time>{formatAgentTime(card.events[0].at)}</time>
              </button>
            </div>
          </div>;
        })}
      </div>
    </div>
    {selected && selectedLane && <FlowDetail card={selected} lane={selectedLane}
      title={describe(selected, names).title} onClose={() => setOpenId(undefined)} />}
  </>;
}
