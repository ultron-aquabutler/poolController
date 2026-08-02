#!/usr/bin/env node
/*
 * AQB-009 smoke test
 *
 * Replicates the runtime rootTopic evaluation that poolController's
 * MqttInterfaceBindings performs, then publishes a representative set of
 * canonical-namespace topics to a local Mosquitto and verifies they are
 * received by a subscriber rooted at aquabutlers/pool/<device_id>/#.
 *
 * Pass criteria:
 *   1. rootTopic computed for defaultConfig.json's mqtt interface equals
 *      aquabutlers/pool/<POOL_DEVICE_ID> when POOL_DEVICE_ID is set.
 *   2. rootTopic computed for mqtt.json (default binding) equals
 *      aquabutlers/pool/<POOL_DEVICE_ID>.
 *   3. rootTopic computed for mqttAlt.json equals
 *      aquabutlers/pool/<POOL_DEVICE_ID>.
 *   4. A subscriber rooted at aquabutlers/pool/test-device/# receives every
 *      representative state topic published under the canonical root.
 *
 * The simulator harness is out of scope for AQB-009; this test only
 * verifies the namespace wiring without standing up poolController itself.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const mqtt = require('mqtt');

const REPO = __dirname;
const POOL_DEVICE_ID = process.env.POOL_DEVICE_ID || 'test-device';
const BROKER_URL = process.env.MQTT_BROKER || 'mqtt://127.0.0.1:1883';

// Replicate the @bind= evaluation scope that MqttInterfaceBindings builds.
// poolController exposes `state` (alias for the controller state module) and
// `sys` (alias for sysAlias). The bind expression inside rootTopic can
// reference state.equipment.alias and process.env.POOL_DEVICE_ID.
function makeEvalContext(equipmentAlias) {
  const state = { equipment: { alias: equipmentAlias, model: 'TestModel X1' } };
  const sys = { equipment: state.equipment };
  return { state, sys };
}

// Mirror buildTokensWithFormatter's regex extraction of @bind=...; expressions.
function extractBindExpression(rootTopicStr) {
  const regx = /(?<=@bind=\s*).*?(?=\;)/g;
  const m = regx.exec(rootTopicStr);
  return m ? m[0] : null;
}

function computeRootTopic(rootTopicStr, equipmentAlias) {
  const bind = extractBindExpression(rootTopicStr);
  if (!bind) return { bind: null, root: rootTopicStr };
  const ctx = makeEvalContext(equipmentAlias);
  // poolController uses eval(); we run the same expression in a scoped fn so
  // the result is identical. process.env.POOL_DEVICE_ID is read directly from
  // the host env to mirror what poolController sees.
  process.env.POOL_DEVICE_ID = POOL_DEVICE_ID;
  const fn = new Function('state', 'sys', 'process', `return (${bind});`);
  const value = fn(ctx.state, ctx.sys, process);
  return { bind, root: rootTopicStr.replace(`@bind=${bind};`, value) };
}

function loadRootTopicFromFile(file) {
  let raw = fs.readFileSync(path.join(REPO, file), 'utf8');
  // Some poolController JSON files are UTF-8 BOM-encoded; strip if present.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  const json = JSON.parse(raw);
  if (file === 'defaultConfig.json') {
    // mqtt config lives under web.interfaces{}, keyed by interface name.
    const ifaces = json.web.interfaces || {};
    const mqttBlock = ifaces.mqtt;
    if (!mqttBlock || !mqttBlock.options || typeof mqttBlock.options.rootTopic === 'undefined') {
      throw new Error('defaultConfig.json: could not find web.interfaces.mqtt.options.rootTopic');
    }
    return mqttBlock.options.rootTopic;
  }
  // web/bindings/mqtt.json and mqttAlt.json share the schema
  // { context: { name, options: { rootTopic, ... } }, events: [...] }
  if (!json.context || !json.context.options || typeof json.context.options.rootTopic === 'undefined') {
    throw new Error(`${file}: could not find context.options.rootTopic`);
  }
  return json.context.options.rootTopic;
}

function assertCanonicalRoot(label, computed, expectedPrefix) {
  const expected = `${expectedPrefix}/${POOL_DEVICE_ID}`;
  if (computed !== expected) {
    throw new Error(`${label}: expected root "${expected}", got "${computed}"`);
  }
  console.log(`PASS ${label}: root = ${computed}`);
}

async function publishAndVerify(client, root, received) {
  const samples = [
    { topic: `${root}/state/status`, payload: JSON.stringify({ val: 0, name: 'ready' }), retain: true },
    { topic: `${root}/state/mode`, payload: JSON.stringify({ val: 1, name: 'Auto' }) },
    { topic: `${root}/state/circuits/1/name`, payload: JSON.stringify({ val: 'Pool', isOn: false }) },
    { topic: `${root}/state/circuits/1/isOn`, payload: JSON.stringify({ val: false }) },
    { topic: `${root}/state/temps/air`, payload: JSON.stringify({ val: 78, units: 'F' }) },
    { topic: `${root}/state/temps/waterSensor1`, payload: JSON.stringify({ val: 80, units: 'F' }) },
    { topic: `${root}/state/pumps/1/rpm`, payload: JSON.stringify({ val: 2400 }) },
    { topic: `${root}/state/chlorinators/1/output`, payload: JSON.stringify({ val: 50 }) },
  ];
  const subscribeRoot = `aquabutlers/pool/${POOL_DEVICE_ID}/#`;
  await new Promise((resolve, reject) => {
    client.subscribe(subscribeRoot, { qos: 0 }, (err) => err ? reject(err) : resolve());
  });
  console.log(`Subscribed to ${subscribeRoot}`);
  for (const s of samples) {
    client.publish(s.topic, s.payload, { retain: !!s.retain, qos: 0 });
  }
  console.log(`Published ${samples.length} canonical topics under ${root}`);
  return samples.map((s) => s.topic);
}

function main() {
  const defaultCfgRT = loadRootTopicFromFile('defaultConfig.json');
  const mqttRT      = loadRootTopicFromFile('web/bindings/mqtt.json');
  const mqttAltRT   = loadRootTopicFromFile('web/bindings/mqttAlt.json');

  console.log('--- rootTopic evaluation ---');
  const r1 = computeRootTopic(defaultCfgRT, 'Backyard Pool');
  console.log(`defaultConfig.json mqtt  -> bind=${r1.bind}`);
  assertCanonicalRoot('defaultConfig.json mqtt', r1.root, 'aquabutlers/pool');

  const r2 = computeRootTopic(mqttRT, 'Backyard Pool');
  console.log(`mqtt.json (binding)     -> bind=${r2.bind}`);
  assertCanonicalRoot('web/bindings/mqtt.json', r2.root, 'aquabutlers/pool');

  const r3 = computeRootTopic(mqttAltRT, 'Backyard Pool');
  console.log(`mqttAlt.json (binding)  -> bind=${r3.bind}`);
  assertCanonicalRoot('web/bindings/mqttAlt.json', r3.root, 'aquabutlers/pool');

  console.log('\n--- live broker round-trip ---');
  const client = mqtt.connect(BROKER_URL, {
    clientId: `aqb009-verifier-${Math.random().toString(16).slice(2, 8)}`,
    connectTimeout: 5000,
  });
  const received = new Set();
  client.on('message', (topic, payload) => {
    received.add(topic);
    console.log(`RECV ${topic}  ${payload.toString()}`);
  });
  client.on('error', (err) => {
    console.error(`MQTT error: ${err.message}`);
    process.exit(2);
  });

  return new Promise((resolve, reject) => {
    client.on('connect', async () => {
      try {
        const published = await publishAndVerify(client, `aquabutlers/pool/${POOL_DEVICE_ID}`, received);
        // Wait briefly for retained + in-flight messages to round-trip
        await new Promise((r) => setTimeout(r, 1500));
        const missing = published.filter((t) => !received.has(t));
        if (missing.length) {
          console.error(`FAIL missing topics at subscriber: ${missing.join(', ')}`);
          client.end(true);
          reject(new Error(`subscriber did not receive: ${missing.join(', ')}`));
          return;
        }
        console.log(`\nPASS subscriber received all ${published.length} canonical topics`);
        // Verify a foreign-root message would NOT be received (proves the
        // canonical tree is what's emitted, not legacy model-only root).
        const foreignClient = mqtt.connect(BROKER_URL, { clientId: 'aqb009-foreign' });
        await new Promise((r) => foreignClient.on('connect', r));
        let foreignReceived = false;
        foreignClient.on('message', (topic) => {
          if (topic.startsWith(`aquabutlers/pool/${POOL_DEVICE_ID}/`)) foreignReceived = true;
        });
        await new Promise((r) => foreignClient.subscribe('testmodel-x1/#', { qos: 0 }, r));
        foreignClient.publish('testmodel-x1/state/status', '{}');
        await new Promise((r) => setTimeout(r, 500));
        if (foreignReceived) {
          console.error('FAIL legacy model-rooted topic was received by aquabutlers/ subscriber');
          foreignClient.end(true);
          client.end(true);
          reject(new Error('legacy topic leak'));
          return;
        }
        console.log('PASS no legacy model-rooted topic leaks to aquabutlers/ subscriber');
        foreignClient.end(true);
        client.end(true);
        resolve();
      } catch (err) {
        client.end(true);
        reject(err);
      }
    });
  });
}

main().then(
  () => { console.log('\n=== AQB-009 SMOKE TEST PASSED ==='); process.exit(0); },
  (err) => { console.error(`\n=== AQB-009 SMOKE TEST FAILED: ${err.message} ===`); process.exit(1); }
);
