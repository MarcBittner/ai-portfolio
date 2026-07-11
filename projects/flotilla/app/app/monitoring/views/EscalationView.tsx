"use client";

import { useState } from "react";
import { Button } from "../../../components/ui";
import {
  useApi,
  Table,
  Th,
  Td,
  EmptyRow,
  RowMenu,
  DegradedNote,
  Modal,
  useConfirm,
} from "../../../components/kit";
import {
  field,
  numInput,
  channelSummary,
  Labeled,
  type ContactsResp,
  type Contact,
  type ContactGroupsResp,
  type ContactGroup,
  type PoliciesResp,
  type Policy,
} from "../_shared";

// ── Escalation (contacts · contact-groups · policies) — admin-managed ────────
async function sendJson(
  url: string,
  method: "POST" | "PATCH" | "DELETE",
  body: Record<string, unknown> | undefined,
  setBanner: (s: string) => void,
): Promise<boolean> {
  const res = await fetch(url, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok || json.error) {
    setBanner(`Error: ${json.error ?? `request failed (${res.status})`}`);
    return false;
  }
  return true;
}

type ChannelDraft = { kind: "slack" | "email"; value: string };
type TierDraft = { afterMinutes: number; contactGroupId: string; repeatEveryMinutes: number | "" };

export default function EscalationView({
  isAdmin,
  policies,
  setBanner,
}: {
  isAdmin: boolean;
  policies: Policy[];
  setBanner: (s: string) => void;
}) {
  const { data: contactsData, mutate: mutateContacts } = useApi<ContactsResp>(isAdmin ? "/api/monitoring/contacts" : null);
  const { data: groupsData, mutate: mutateGroups } = useApi<ContactGroupsResp>("/api/monitoring/contact-groups");
  const { mutate: mutatePolicies } = useApi<PoliciesResp>("/api/monitoring/escalation-policies");
  const { confirm, dialog } = useConfirm();

  // Contact create modal state.
  const [contactOpen, setContactOpen] = useState(false);
  const [contactName, setContactName] = useState("");
  const [contactChannels, setContactChannels] = useState<ChannelDraft[]>([{ kind: "slack", value: "" }]);
  // Group create modal state.
  const [groupOpen, setGroupOpen] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupContactIds, setGroupContactIds] = useState<string[]>([]);
  // Policy create modal state.
  const [policyOpen, setPolicyOpen] = useState(false);
  const [policyName, setPolicyName] = useState("");
  const [tiers, setTiers] = useState<TierDraft[]>([{ afterMinutes: 0, contactGroupId: "", repeatEveryMinutes: "" }]);

  const contacts = contactsData?.contacts ?? [];
  const groups = groupsData?.groups ?? [];
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const contactNameById = new Map(contacts.map((c) => [c.id, c.name]));

  if (!isAdmin) {
    return (
      <div className="glass p-6 text-sm text-[--color-muted]">
        Managing contacts, contact-groups, and escalation policies is limited to admins and
        super-admins (escalation config is admin-gated). Attach an existing policy to a monitor from
        the monitor editor; there {policies.length === 1 ? "is" : "are"} currently {policies.length}{" "}
        policy{policies.length === 1 ? "" : "ies"} defined.
      </div>
    );
  }

  const addContact = async () => {
    const channels = contactChannels
      .filter((c) => c.value.trim())
      .map((c) => (c.kind === "slack" ? { kind: "slack", webhookUrl: c.value.trim() } : { kind: "email", address: c.value.trim() }));
    if (!contactName.trim()) return;
    if (!(await sendJson("/api/monitoring/contacts", "POST", { name: contactName.trim(), channels }, setBanner))) return;
    setBanner(`Added contact “${contactName.trim()}”.`);
    setContactOpen(false);
    setContactName("");
    setContactChannels([{ kind: "slack", value: "" }]);
    void mutateContacts();
  };

  const removeContact = async (c: Contact) => {
    if (!(await confirm({ title: `Remove contact “${c.name}”?`, body: "Removed from any contact-group fan-out.", danger: true, confirmText: "Remove" }))) return;
    if (!(await sendJson(`/api/monitoring/contacts/${c.id}`, "DELETE", undefined, setBanner))) return;
    setBanner(`Removed contact “${c.name}”.`);
    void mutateContacts();
    void mutateGroups();
  };

  const addGroup = async () => {
    if (!groupName.trim()) return;
    if (!(await sendJson("/api/monitoring/contact-groups", "POST", { name: groupName.trim(), contactIds: groupContactIds }, setBanner))) return;
    setBanner(`Added contact-group “${groupName.trim()}”.`);
    setGroupOpen(false);
    setGroupName("");
    setGroupContactIds([]);
    void mutateGroups();
  };

  const removeGroup = async (g: ContactGroup) => {
    if (!(await confirm({ title: `Remove contact-group “${g.name}”?`, body: "Escalation tiers referencing it will page no one.", danger: true, confirmText: "Remove" }))) return;
    if (!(await sendJson(`/api/monitoring/contact-groups/${g.id}`, "DELETE", undefined, setBanner))) return;
    setBanner(`Removed group “${g.name}”.`);
    void mutateGroups();
  };

  const addPolicy = async () => {
    const cleanTiers = tiers
      .filter((t) => t.contactGroupId)
      .map((t) => ({
        afterMinutes: Math.max(0, t.afterMinutes),
        contactGroupId: t.contactGroupId,
        ...(t.repeatEveryMinutes !== "" && Number(t.repeatEveryMinutes) > 0 ? { repeatEveryMinutes: Number(t.repeatEveryMinutes) } : {}),
      }));
    if (!policyName.trim() || cleanTiers.length === 0) {
      setBanner("A policy needs a name and at least one tier with a contact-group.");
      return;
    }
    if (!(await sendJson("/api/monitoring/escalation-policies", "POST", { name: policyName.trim(), tiers: cleanTiers }, setBanner))) return;
    setBanner(`Added escalation policy “${policyName.trim()}”.`);
    setPolicyOpen(false);
    setPolicyName("");
    setTiers([{ afterMinutes: 0, contactGroupId: "", repeatEveryMinutes: "" }]);
    void mutatePolicies();
  };

  const removePolicy = async (p: Policy) => {
    if (!(await confirm({ title: `Remove policy “${p.name}”?`, body: "Monitors referencing it fall back to direct re-notify.", danger: true, confirmText: "Remove" }))) return;
    if (!(await sendJson(`/api/monitoring/escalation-policies/${p.id}`, "DELETE", undefined, setBanner))) return;
    setBanner(`Removed policy “${p.name}”.`);
    void mutatePolicies();
  };

  return (
    <div className="space-y-8">
      {dialog}

      {/* Contacts */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Contacts</h2>
          <Button variant="primary" onClick={() => setContactOpen(true)}>
            Add contact
          </Button>
        </div>
        {contactsData?.degraded && <DegradedNote reason={contactsData.reason} />}
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Channels (secrets masked)</Th>
              <Th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {contacts.length === 0 && <EmptyRow cols={3}>No contacts yet. A contact carries a Slack webhook and/or an email address.</EmptyRow>}
            {contacts.map((c) => (
              <tr key={c.id} className="hover:bg-[--color-accent]/5">
                <Td className="font-medium">{c.name}</Td>
                <Td className="max-w-md text-xs text-[--color-muted]">
                  <span className="block max-w-md truncate" title={channelSummary(c)}>{channelSummary(c)}</span>
                </Td>
                <Td>
                  <RowMenu items={[{ label: "Remove", onSelect: () => void removeContact(c), danger: true }]} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      {/* Contact-groups */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Contact-groups</h2>
          <Button variant="primary" onClick={() => setGroupOpen(true)}>
            Add group
          </Button>
        </div>
        {groupsData?.degraded && <DegradedNote reason={groupsData.reason} />}
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Members</Th>
              <Th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {groups.length === 0 && <EmptyRow cols={3}>No contact-groups yet. Groups are the fan-out unit an escalation tier notifies.</EmptyRow>}
            {groups.map((g) => (
              <tr key={g.id} className="hover:bg-[--color-accent]/5">
                <Td className="font-medium">{g.name}</Td>
                <Td className="text-xs text-[--color-muted]">
                  {g.contactIds.length === 0 ? "—" : g.contactIds.map((id) => contactNameById.get(id) ?? id).join(", ")}
                </Td>
                <Td>
                  <RowMenu items={[{ label: "Remove", onSelect: () => void removeGroup(g), danger: true }]} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      {/* Policies */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-sm font-semibold">Escalation policies</h2>
          <Button variant="primary" onClick={() => setPolicyOpen(true)}>
            Add policy
          </Button>
        </div>
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Tiers</Th>
              <Th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {policies.length === 0 && <EmptyRow cols={3}>No policies yet. A policy is an ordered ladder of tiers ({"{ afterMinutes, contact-group }"}).</EmptyRow>}
            {policies.map((p) => (
              <tr key={p.id} className="hover:bg-[--color-accent]/5">
                <Td className="font-medium">{p.name}</Td>
                <Td className="text-xs text-[--color-muted]">
                  {p.tiers
                    .map((t, i) => `#${i} @${t.afterMinutes}m → ${groupById.get(t.contactGroupId)?.name ?? t.contactGroupId}${t.repeatEveryMinutes ? ` (↻${t.repeatEveryMinutes}m)` : ""}`)
                    .join("  ·  ")}
                </Td>
                <Td>
                  <RowMenu items={[{ label: "Remove", onSelect: () => void removePolicy(p), danger: true }]} />
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      {/* Add contact modal */}
      <Modal
        open={contactOpen}
        onClose={() => setContactOpen(false)}
        title="Add contact"
        footer={
          <>
            <Button variant="ghost" onClick={() => setContactOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!contactName.trim()} onClick={() => void addContact()}>Add</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Labeled label="Name">
            <input className={`w-full ${field}`} value={contactName} onChange={(e) => setContactName(e.target.value)} placeholder="On-call · #alerts" autoFocus />
          </Labeled>
          <div>
            <span className="mb-1 block text-xs text-[--color-muted]">Channels</span>
            <div className="space-y-2">
              {contactChannels.map((ch, i) => (
                <div key={i} className="flex items-center gap-2">
                  <select
                    className={field}
                    value={ch.kind}
                    onChange={(e) => setContactChannels(contactChannels.map((c, j) => (j === i ? { ...c, kind: e.target.value as "slack" | "email" } : c)))}
                  >
                    <option value="slack">slack</option>
                    <option value="email">email</option>
                  </select>
                  <input
                    className={`flex-1 ${field}`}
                    value={ch.value}
                    onChange={(e) => setContactChannels(contactChannels.map((c, j) => (j === i ? { ...c, value: e.target.value } : c)))}
                    placeholder={ch.kind === "slack" ? "https://hooks.slack.com/…" : "ops@example.com"}
                  />
                  <button
                    type="button"
                    className="text-xs text-[--color-muted] hover:text-[--color-ink]"
                    onClick={() => setContactChannels(contactChannels.filter((_, j) => j !== i))}
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 text-xs text-[--color-accent] hover:underline"
              onClick={() => setContactChannels([...contactChannels, { kind: "slack", value: "" }])}
            >
              + add channel
            </button>
          </div>
        </div>
      </Modal>

      {/* Add group modal */}
      <Modal
        open={groupOpen}
        onClose={() => setGroupOpen(false)}
        title="Add contact-group"
        footer={
          <>
            <Button variant="ghost" onClick={() => setGroupOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!groupName.trim()} onClick={() => void addGroup()}>Add</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Labeled label="Name">
            <input className={`w-full ${field}`} value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Tier-2 on-call" autoFocus />
          </Labeled>
          <div>
            <span className="mb-1 block text-xs text-[--color-muted]">Members</span>
            {contacts.length === 0 ? (
              <p className="text-xs text-[--color-muted]">Add contacts first.</p>
            ) : (
              <div className="space-y-1">
                {contacts.map((c) => (
                  <label key={c.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={groupContactIds.includes(c.id)}
                      onChange={(e) =>
                        setGroupContactIds(e.target.checked ? [...groupContactIds, c.id] : groupContactIds.filter((x) => x !== c.id))
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>

      {/* Add policy modal */}
      <Modal
        open={policyOpen}
        onClose={() => setPolicyOpen(false)}
        title="Add escalation policy"
        className="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => setPolicyOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={!policyName.trim()} onClick={() => void addPolicy()}>Add</Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <Labeled label="Name">
            <input className={`w-full ${field}`} value={policyName} onChange={(e) => setPolicyName(e.target.value)} placeholder="Prod pager ladder" autoFocus />
          </Labeled>
          <div>
            <span className="mb-1 block text-xs text-[--color-muted]">Tiers (ascending afterMinutes)</span>
            {groups.length === 0 && <p className="mb-2 text-xs text-[--color-warn]">Add a contact-group first — a tier needs one.</p>}
            <div className="space-y-2">
              {tiers.map((t, i) => (
                <div key={i} className="flex items-end gap-2">
                  <label className="block">
                    <span className="mb-1 block text-[0.65rem] text-[--color-muted]">after (min)</span>
                    <input
                      type="number"
                      min={0}
                      className={numInput}
                      value={t.afterMinutes}
                      onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, afterMinutes: Math.max(0, Number(e.target.value) || 0) } : x)))}
                    />
                  </label>
                  <label className="block flex-1">
                    <span className="mb-1 block text-[0.65rem] text-[--color-muted]">contact-group</span>
                    <select
                      className={`w-full ${field}`}
                      value={t.contactGroupId}
                      onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, contactGroupId: e.target.value } : x)))}
                    >
                      <option value="">select…</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-[0.65rem] text-[--color-muted]">repeat (min)</span>
                    <input
                      type="number"
                      min={0}
                      className={numInput}
                      value={t.repeatEveryMinutes}
                      onChange={(e) => setTiers(tiers.map((x, j) => (j === i ? { ...x, repeatEveryMinutes: e.target.value === "" ? "" : Math.max(0, Number(e.target.value) || 0) } : x)))}
                      placeholder="off"
                    />
                  </label>
                  <button
                    type="button"
                    className="pb-2 text-xs text-[--color-muted] hover:text-[--color-ink]"
                    onClick={() => setTiers(tiers.filter((_, j) => j !== i))}
                  >
                    remove
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="mt-2 text-xs text-[--color-accent] hover:underline"
              onClick={() => setTiers([...tiers, { afterMinutes: 0, contactGroupId: "", repeatEveryMinutes: "" }])}
            >
              + add tier
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
