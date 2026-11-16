# Shopping lists in Home Assistant

Home Assistant holds the lists (one per shop). The frame mirrors them over MQTT. Two automations do the work,
and they can only touch the four lists named below: nothing else in Home Assistant is reachable from here.

## 1. Create the four lists

**Settings → Devices & services → Add integration → "Local To-do"**, once per shop. Use these exact names so the
entity ids come out as shown (check them under Settings → Entities):

| Name to type | Entity id | Shows on the frame as |
| --- | --- | --- |
| Costco | `todo.costco` | Costco |
| Safeway | `todo.safeway` | Safeway |
| Trader Joes | `todo.trader_joes` | Trader Joe's |
| Other | `todo.other` | Other |

(No apostrophe in the Home Assistant name: it would change the entity id. The frame's name is set in its own settings.)

## 2. Add the two automations

**Settings → Automations & scenes → Create automation → ⋮ → Edit in YAML**, paste, save. Do this twice.
If you used different list names, change the four entity ids in both.

### A. Publish the lists (Home Assistant → frame)

```yaml
alias: Shopping lists to the frame
description: Publishes each shop's to-do list over MQTT when it changes, every 5 minutes, at startup and on request.
mode: queued
max: 10
triggers:
  - trigger: state
    entity_id:
      - todo.costco
      - todo.safeway
      - todo.trader_joes
      - todo.other
  - trigger: homeassistant
    event: start
  - trigger: time_pattern
    minutes: "/5"
  - trigger: mqtt
    topic: photoframe/lists/refresh
actions:
  - repeat:
      for_each:
        - todo.costco
        - todo.safeway
        - todo.trader_joes
        - todo.other
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
            topic: "photoframe/lists/{{ repeat.item.split('.')[1] }}/items"
            retain: true
            payload: "{{ {'items': got[repeat.item]['items']} | tojson }}"
```

### B. Carry out the frame's changes (frame → Home Assistant)

```yaml
alias: Shopping lists from the frame
description: Adds, ticks, renames and removes items on the four shop lists when the frame asks over MQTT.
mode: queued
max: 20
triggers:
  - trigger: mqtt
    topic: photoframe/lists/+/cmd
conditions:
  - condition: template
    value_template: >-
      {{ trigger.topic.split('/')[2] in ['costco', 'safeway', 'trader_joes', 'other']
         and trigger.payload_json is mapping }}
actions:
  - variables:
      entity: "todo.{{ trigger.topic.split('/')[2] }}"
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

These use the current automation syntax (`triggers:` / `actions:` / `action:`), from Home Assistant 2024.10 on.

## 3. Turn it on for the frame

On the server, in `config/settings.json`, set `"homeAssistantLists": true` under `shopping` and restart
`photoframe.service`. Until then the Shopping tab uses its own local list.

## What the frame can and cannot do

- Add, tick, rename and clear items; move one to another shop. Each change reaches Home Assistant in about a second.
- Aisle, quantity and note are kept on the server only (Home Assistant's lists hold just a name and a done flag).
  An item added in the Home Assistant app gets its aisle guessed from the usual-items list.
- If Home Assistant or MQTT is down, the frame shows the last list it saw and refuses changes instead of keeping
  its own copy, so the two never disagree.
- Voice (Assist) and the Home Assistant app work on the same lists. Whether Assist accepts a list name depends on your version.
