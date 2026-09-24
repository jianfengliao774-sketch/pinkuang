"""Read-only, pinned-block Q8/Q9 JSON-RPC evidence. Standard library only.

Run from repository root: python scripts/m0/token-evidence.py
No signing keys, eth_sendTransaction, or state overrides are used.
The independent fork tests provide execution evidence for mint permissions/swaps.
"""

import hashlib
import json
import os
from pathlib import Path
import urllib.request


BLOCK = 123728000
BLOCK_HASH = "0x18c5cda4bb465d1a9aae3d4fe66150cffbe187e2488b856a93f4376080e26306"
RPC = os.environ.get("BSC_RPC_URL", "https://bsc-mainnet.public.blastapi.io")
ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs/logs/T0.2"
BEM = "0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a"
MINING = "0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46"
POOL = "0x28B12792F9D81Bd529Bc5572434E861C9EDbBBC2"
ROUTER = "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4"
WBNB = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"
IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
TRANSCRIPT = []


def rpc(method, params):
    payload = {"jsonrpc": "2.0", "id": len(TRANSCRIPT) + 1, "method": method, "params": params}
    request = urllib.request.Request(
        RPC,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "User-Agent": "Mozilla/5.0"},
    )
    with urllib.request.urlopen(request, timeout=40) as response:
        result = json.load(response)
    TRANSCRIPT.append({"request": payload, "response": result})
    return result


def call(address, signature, selector, argument=""):
    result = rpc("eth_call", [{"to": address, "data": selector + argument}, hex(BLOCK)])
    return {"signature": signature, "selector": selector, "raw": result}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    block = rpc("eth_getBlockByNumber", [hex(BLOCK), False])["result"]
    assert block["hash"].lower() == BLOCK_HASH, "Unexpected fixed-block hash"
    assert int(rpc("eth_chainId", [])["result"], 16) == 56
    summary = {
        "block": BLOCK,
        "blockHash": block["hash"],
        "blockTimestamp": int(block["timestamp"], 16),
        "note": "All contract reads use the explicit block tag; no latest-state conclusions.",
        "calls": [],
    }
    queries = [
        (BEM, "minter()", "0x07546172"),
        (BEM, "decimals()", "0x313ce567"),
        (BEM, "MAX_SUPPLY()", "0x32cb6b0c"),
        (BEM, "totalSupply()", "0x18160ddd"),
        (BEM, "owner()", "0x8da5cb5b"),
        (MINING, "owner()", "0x8da5cb5b"),
        (MINING, "isSealed()", "0x631f9852"),
        (POOL, "token0()", "0x0dfe1681"),
        (POOL, "token1()", "0xd21220a7"),
        (POOL, "fee()", "0xddca3f43"),
        (POOL, "liquidity()", "0x1a686502"),
        (POOL, "slot0()", "0x3850c7bd"),
        (POOL, "factory()", "0xc45a0155"),
        (ROUTER, "factory()", "0xc45a0155"),
        (ROUTER, "WETH9()", "0x4aa4a4fc"),
        (WBNB, "decimals()", "0x313ce567"),
    ]
    for address, signature, selector in queries:
        item = call(address, signature, selector)
        item["address"] = address
        summary["calls"].append(item)
    for address in [BEM, WBNB]:
        item = call(address, "balanceOf(address)", "0x70a08231", POOL[2:].lower().zfill(64))
        item["address"] = address
        item["argument"] = POOL
        summary["calls"].append(item)
    summary["miningImplementationSlot"] = rpc("eth_getStorageAt", [MINING, IMPLEMENTATION_SLOT, hex(BLOCK)])
    code = rpc("eth_getCode", [BEM, hex(BLOCK)])["result"]
    raw = bytes.fromhex(code[2:])
    (OUT / "token-bem-runtime.hex").write_text(code + "\n", encoding="utf-8")
    summary["bemRuntimeBytes"] = len(raw)
    summary["bemRuntimeSha256"] = hashlib.sha256(raw).hexdigest()
    # Disassemble the exact deployed mint entry body. The dispatcher at PC 0x60
    # compares selector 0x40c10f19 and jumps to 0x02f8. At PC 0x31f a PUSH32
    # embeds the Mining address; CALLER/SUB gate branches to a revert on mismatch.
    opnames = {
        0x00: "STOP", 0x01: "ADD", 0x03: "SUB", 0x10: "LT", 0x11: "GT", 0x12: "SLT", 0x14: "EQ",
        0x15: "ISZERO", 0x16: "AND", 0x19: "NOT", 0x1B: "SHL", 0x33: "CALLER",
        0x34: "CALLVALUE", 0x35: "CALLDATALOAD", 0x36: "CALLDATASIZE", 0x50: "POP",
        0x51: "MLOAD", 0x52: "MSTORE", 0x54: "SLOAD", 0x55: "SSTORE", 0x56: "JUMP",
        0x57: "JUMPI", 0x5B: "JUMPDEST", 0x5F: "PUSH0", 0xA3: "LOG3", 0xFD: "REVERT",
    }
    lines = ["BEM deployed runtime: selector 0x40c10f19 => PC 0x02f8", "Fixed block: " + str(BLOCK)]
    pc = 0x2F8
    while pc < 0x3EA:
        opcode = raw[pc]
        start = pc
        pc += 1
        if 0x60 <= opcode <= 0x7F:
            n = opcode - 0x5F
            name = f"PUSH{n} 0x{raw[pc:pc+n].hex()}"
            pc += n
        elif 0x80 <= opcode <= 0x8F:
            name = "DUP" + str(opcode - 0x7F)
        elif 0x90 <= opcode <= 0x9F:
            name = "SWAP" + str(opcode - 0x8F)
        else:
            name = opnames.get(opcode, f"OP_0x{opcode:02x}")
        lines.append(f"0x{start:04x} {name}")
    (OUT / "token-mint-disassembly.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    (OUT / "token-chain-evidence.json").write_text(
        json.dumps({"summary": summary, "transcript": TRANSCRIPT}, indent=2) + "\n", encoding="utf-8"
    )
    print("Saved fixed-block BEM permissions, runtime, pool/router identities, and raw RPC responses.")


if __name__ == "__main__":
    main()
