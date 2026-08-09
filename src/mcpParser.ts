import * as fs from 'fs';

export interface StationConfig {
    name: string;
    subdivision: string;
    controlMnemonics: string[];
    indicationMnemonics: string[];
    indicationBits: number; // ADD THIS
}

export type McpDictionary = Record<string, StationConfig>;

export function parseMcpFile(filePath: string): McpDictionary {
    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    const tempGrouping: Record<string, any> = {};

    for (const line of lines) {
        const match = line.match(/^MCP([A-Za-z]+)(\d+)=(.*)$/);
        if (!match) continue;

        const [_, key, index, value] = match;
        if (!tempGrouping[index]) tempGrouping[index] = {};

        const cleanValue = value.trim();

        switch (key) {
        case 'Address':
            tempGrouping[index].address = cleanValue;
            break;
        case 'Name':
            tempGrouping[index].name = cleanValue;
            break;
        case 'Subdivision':
            tempGrouping[index].subdivision = cleanValue;
            break;
        case 'ControlMnemonics':
            tempGrouping[index].controls = cleanValue.split(',');
            break;
        case 'IndicationMnemonics':
            tempGrouping[index].indications = cleanValue.split(',');
            break;
        case 'IndicationBits':
            tempGrouping[index].indicationBits = parseInt(cleanValue, 10);
            break;
        }
    }

    const dictionary: McpDictionary = {};
    for (const idx in tempGrouping) {
        const station = tempGrouping[idx];
        if (station.address) {
            dictionary[station.address] = {
                name: station.name || 'Unknown',
                subdivision: station.subdivision || 'Unknown',
                controlMnemonics: station.controls || [],
                indicationMnemonics: station.indications || [],
                indicationBits: station.indicationBits || 0
            };
        }
    }
    return dictionary;
}