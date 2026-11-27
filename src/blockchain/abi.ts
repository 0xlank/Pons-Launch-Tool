export const PONS_FACTORY_ABI = [
  {
    type: 'function',
    name: 'launchFee',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'launchToken',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'params',
        type: 'tuple',
        components: [
          { name: 'name', type: 'string' },
          { name: 'symbol', type: 'string' },
          { name: 'logo', type: 'string' },
          { name: 'description', type: 'string' },
          {
            name: 'socials',
            type: 'tuple',
            components: [
              { name: 'twitter', type: 'string' },
              { name: 'telegram', type: 'string' },
              { name: 'discord', type: 'string' },
              { name: 'website', type: 'string' },
              { name: 'github', type: 'string' },
            ],
          },
          { name: 'creatorFeeRecipient', type: 'address' },
          { name: 'creatorTaxBps', type: 'uint16' },
          { name: 'buybackEnabled', type: 'bool' },
          { name: 'expectedEconomics', type: 'bytes32' },
          { name: 'salt', type: 'bytes32' },
        ],
      },
      { name: 'launchConfigId', type: 'uint256' },
      { name: 'pairToken', type: 'address' },
    ],
    outputs: [
      { name: 'token', type: 'address' },
      { name: 'curve', type: 'address' },
    ],
  },
] as const;
