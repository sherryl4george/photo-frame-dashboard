# Shopping lists in Home Assistant

The shops can each be backed by a Home Assistant to-do list. The frame and the phones mirror them over MQTT, with
Home Assistant as the master (voice, the Home Assistant app and automations all work on the same lists). Two
automations do the work. A shop **without** a Home Assistant list simply keeps its items on the server, so nothing
has to be set up for a new shop to work; create the list later and the items move across by themselves.

## 1. Create a to-do list per shop

**Settings → Devices & services → Add integration → "Local To-do"**, once per shop. Name each one
**`Shopping <shop name>`** with no punctuation. The entity id then comes out as `todo.shopping_<shop id>`
(check under Settings → Entities), and the automations find every list that starts with `todo.shopping_`.

| Name to type | Entity id | Shop on the frame and phones |
| --- | --- | --- |
| Shopping Costco | `todo.shopping_costco` | Costco |
| Shopping Safeway | `todo.shopping_safeway` | Safeway |
| Shopping Trader Joes | `todo.shopping_trader_joes` | Trader Joe's |
| Shopping Other | `todo.shopping_other` | Other |

**A new shop later:** add it on the phone page (the ⋮ menu → Manage shops). It works at once. When you want it in
Home Assistant too, create a list named `Shopping <the shop's name>` (the sheet tells you the exact name and entity
id). Its id is the shop's name in lower case with punctuation removed and spaces turned into `_`
(Whole Foods → `whole_foods`, Joe's Market → `joes_market`). No automation needs editing.

## 2. Add the two automations (once)

**Settings → Automations & scenes → Create automation → ⋮ → Edit in YAML**, paste, save. Do this twice.

### A. Publish the lists (Home Assistant → frame)

```yaml
alias: Shopping lists to the frame
description: Publishes every "Shopping ..." to-do list over MQTT when any of them changes, every 30 seconds, at startup and on request.
mode: queued
max: 10
triggers:
  - trigger: event
    event_type: state_changed
  - trigger: homeassistant
    event: start
  - trigger: time_pattern
    seconds: "/30"
  - trigger: mqtt
    topic: photoframe/lists/refresh
conditions:
  - condition: template
    value_template: >-
      {{ trigger.platform != 'event'
         or trigger.event.data.entity_id.startswith('todo.shopping_') }}
actions:
  - repeat:
      for_each: >-
        {{ states.todo | map(attribute='entity_id') | select('match', 'todo[.]shopping_') | list }}
      sequence:
        - action: todo.get_items
          target:
            entity_id: "{{ repeat.item }}"
          data:
            status:
              - needs_action
              - completed
          response_variable: got
        - action: mqtt.publish
          data:
            topic: "photoframe/lists/{{ repeat.item.replace('todo.shopping_', '') }}/items"
            retain: true
            payload: "{{ {'items': got[repeat.item]['items']} | tojson }}"
```

The `state_changed` trigger reacts at once when any list whose id starts with `todo.shopping_` changes, so a shop added
later needs no edit. (A plain `state` trigger needs every entity listed by name and has no wildcard.) The condition only
filters that trigger; the timer, startup and refresh triggers run as before. The catch: Home Assistant checks the
condition on every state change in the system, which is cheap but not free, and a list's state is its count of
unfinished items, so a rename shows up on the next 30-second pass. If you would rather not use it, replace that trigger
with a `state` trigger listing your lists and rely on the timer for any new shop.

### B. Carry out the frame's changes (frame → Home Assistant)

```yaml
alias: Shopping lists from the frame
description: Adds, ticks, renames and removes items on the "Shopping ..." lists when the frame or a phone asks over MQTT.
mode: queued
max: 20
triggers:
  - trigger: mqtt
    topic: photoframe/lists/+/cmd
conditions:
  - condition: template
    value_template: >-
      {% set id = trigger.topic.split('/')[2] %}
      {{ id | regex_match('^[a-z0-9_]+$')
         and ('todo.shopping_' ~ id) in (states.todo | map(attribute='entity_id') | list)
         and trigger.payload_json is mapping }}
actions:
  - variables:
      entity: "todo.shopping_{{ trigger.topic.split('/')[2] }}"
      c: "{{ trigger.payload_json }}"
  - choose:
      - conditions: "{{ c.op == 'add' and (c.item | string | length) > 0 }}"
        sequence:
          - action: todo.add_item
            target:
              entity_id: "{{ entity }}"
            data:
              item: "{{ c.item }}"
      - conditions: "{{ c.op == 'done' and c.uid is defined }}"
        sequence:
          - action: todo.update_item
            target:
              entity_id: "{{ entity }}"
            data:
              item: "{{ c.uid }}"
              status: "{{ 'completed' if c.done else 'needs_action' }}"
      - conditions: "{{ c.op == 'rename' and c.uid is defined and (c.item | string | length) > 0 }}"
        sequence:
          - action: todo.update_item
            target:
              entity_id: "{{ entity }}"
            data:
              item: "{{ c.uid }}"
              rename: "{{ c.item }}"
      - conditions: "{{ c.op == 'remove' and c.uid is defined }}"
        sequence:
          - action: todo.remove_item
            target:
              entity_id: "{{ entity }}"
            data:
              item: "{{ c.uid }}"
  - action: mqtt.publish
    data:
      topic: photoframe/lists/refresh
      payload: refresh
```

Both use the current automation syntax (`triggers:` / `actions:` / `action:`), from Home Assistant 2024.10 on.
The only things they can touch are to-do lists whose entity id starts with `todo.shopping_`.

## What the frame and phones can and cannot do

- Add, tick, rename, change quantity, note, aisle and shop; clear with Undo; add and manage shops. A change to a
  Home Assistant shop reaches Home Assistant in about a second.
- Aisle, quantity and note are kept on the server only (Home Assistant's lists hold just a name and a done flag).
  An item added in the Home Assistant app gets its aisle from what was used before, else guessed from the usual items.
- If Home Assistant or MQTT is down, a Home Assistant shop shows its last list and the phone page keeps changes in
  a queue until it is back. A local shop is not affected.
- Voice (Assist) and the Home Assistant app work on the same lists. Whether Assist accepts a list name depends on your version.
