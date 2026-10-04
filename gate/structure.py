"""Minimal PDB utilities: residue lookup and mutation-to-active-site distance.

Used to validate candidates against the actual structure file (wild-type
residue check) and to compute distances when the agents don't supply them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

THREE_TO_ONE = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C",
    "GLN": "Q", "GLU": "E", "GLY": "G", "HIS": "H", "ILE": "I",
    "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P",
    "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
}


@dataclass(frozen=True)
class Atom:
    name: str
    res_name: str
    chain: str
    res_seq: int
    x: float
    y: float
    z: float
    element: str


@lru_cache(maxsize=8)
def load_atoms(path: str) -> tuple[Atom, ...]:
    """ATOM records only; keeps blank or 'A' altlocs, drops hydrogens."""
    atoms = []
    for line in Path(path).read_text().splitlines():
        if not line.startswith("ATOM"):
            continue
        if line[16] not in (" ", "A"):
            continue
        element = line[76:78].strip() or line[12:16].strip()[0]
        if element == "H":
            continue
        atoms.append(Atom(
            name=line[12:16].strip(),
            res_name=line[17:20].strip(),
            chain=line[21],
            res_seq=int(line[22:26]),
            x=float(line[30:38]), y=float(line[38:46]), z=float(line[46:54]),
            element=element,
        ))
    return tuple(atoms)


def residue_atoms(path: str, chain: str, pos: int) -> list[Atom]:
    return [a for a in load_atoms(path) if a.chain == chain and a.res_seq == pos]


def residue_letter(path: str, chain: str, pos: int) -> str | None:
    atoms = residue_atoms(path, chain, pos)
    return THREE_TO_ONE.get(atoms[0].res_name, "X") if atoms else None


def min_distance_to_active_site(
    path: str, chain: str, pos: int, active_site: list[int]
) -> tuple[float, int] | None:
    """Minimum heavy-atom distance (Å) from residue `pos` to any active-site
    residue, and which active-site residue is nearest."""
    mut = residue_atoms(path, chain, pos)
    if not mut:
        return None
    best: tuple[float, int] | None = None
    for site in active_site:
        for b in residue_atoms(path, chain, site):
            for a in mut:
                d = math.dist((a.x, a.y, a.z), (b.x, b.y, b.z))
                if best is None or d < best[0]:
                    best = (d, site)
    return best
