/**
 * Tests ingress connection metrics.
 *
 * @tags: [requires_fcv_61, featureFlagConnHealthMetrics]
 */

"use strict";

(function() {
load("jstests/ssl/libs/ssl_helpers.js");

// We use 'opensslCipherSuiteConfig' to deterministically set the cipher suite negotiated when
// openSSL is being used. This can be different on Windows/OSX implementations.
let cipherSuite = "TLS_AES_256_GCM_SHA384";

const tlsOptions = {
    tlsMode: "requireTLS",
    tlsCertificateKeyFile: "jstests/libs/server.pem",
    tlsCAFile: "jstests/libs/ca.pem",
    setParameter: {opensslCipherSuiteConfig: cipherSuite},
};

function testConn() {
    const mongo = runMongoProgram('mongo',
                                  '--host',
                                  'localhost',
                                  '--port',
                                  mongod.port,
                                  '--tls',
                                  '--tlsCAFile',
                                  'jstests/libs/ca.pem',
                                  '--tlsCertificateKeyFile',
                                  'jstests/libs/client.pem',
                                  '--eval',
                                  ';');
    return mongo === 0;
}

jsTestLog("Establishing connection to mongod");
const mongod = MongoRunner.runMongod(Object.merge(tlsOptions));
let ssNetworkMetrics = mongod.adminCommand({serverStatus: 1}).metrics.network;
let initialHandshakeTimeMillis = ssNetworkMetrics.totalIngressTLSHandshakeTimeMillis;
jsTestLog(`totalTLSHandshakeTimeMillis: ${initialHandshakeTimeMillis}`);
checkLog.containsJson(mongod, 6723804, {durationMillis: Number(initialHandshakeTimeMillis)});
assert.commandWorked(mongod.adminCommand({clearLog: 'global'}));
assert.eq(1, ssNetworkMetrics.totalIngressTLSConnections, ssNetworkMetrics);

// Get the logId that corresponds to the implementation of TLS being used.
let logId;
switch (determineSSLProvider()) {
    case "openssl":
        logId = 6723801;
        break;
    case "windows":
        logId = 6723802;
        // This cipher is chosen to represent the cipher negotiated by Windows Server 2019 by
        // default.
        cipherSuite = "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384";
        break;
    case "apple":
        logId = 6723803;
        // We log only the cipher represented as its enum value in this code path. This corresponds
        // to the hex value 0xC030 which maps to the cipher suite
        // "TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384". This cipher is chosen by OSX 12.1 by default.
        cipherSuite = 49200;
        break;
    default:
        assert(false, "Failed to determine that we are using a supported SSL provider");
}

// Start a new connection to check that 'durationMicros' is cumulatively measured in server status.
assert.soon(testConn, "Couldn't connect to mongod");
ssNetworkMetrics = mongod.adminCommand({serverStatus: 1}).metrics.network;
let totalTLSHandshakeTimeMillis = ssNetworkMetrics.totalIngressTLSHandshakeTimeMillis;
jsTestLog(`totalTLSHandshakeTimeMillis: ${totalTLSHandshakeTimeMillis}`);
let secondHandshakeDuration = totalTLSHandshakeTimeMillis - initialHandshakeTimeMillis;
checkLog.containsJson(mongod, 6723804, {durationMillis: Number(secondHandshakeDuration)});
assert.soon(() => checkLog.checkContainsOnceJson(mongod, logId, {"cipher": cipherSuite}),
            "failed waiting for log line with negotiated cipher info");
assert.gt(totalTLSHandshakeTimeMillis, initialHandshakeTimeMillis);
assert.eq(2, ssNetworkMetrics.totalIngressTLSConnections, ssNetworkMetrics);

MongoRunner.stopMongod(mongod);
}());