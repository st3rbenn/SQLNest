import { Container, Tabs, createStyles, rem } from '@mantine/core';
import React from 'react';
import { ITabs } from '../../App';

type HeaderProps = {
  tabs: ITabs[];
};

function Header(props: HeaderProps) {
  const { tabs } = props;
  const { classes } = useStyles();

  const items = tabs.map((tab) => (
    <Tabs.Tab value={tab.name} key={tab.name} className={classes.tabs} icon={tab.icon}>
      {tab.name}
    </Tabs.Tab>
  ));

  return (
    <Tabs display='flex' dir='column' defaultValue='Information' variant='outline' w='100%' sx={{
      backgroundColor: 'transparent',
      position: 'relative',
      zIndex: 5,
    }}>
      <Container className={classes.container}>{items}</Container>
    </Tabs>
  );
}

const useStyles = createStyles((theme) => ({
  tabs: {
    margin: 0,
    padding: theme.spacing.md,
    paddingTop: rem(24.27),
    paddingBottom: rem(24.27),
    fontSize: rem(14),
    fontWeight: 600,
    color: '#D0CECB',
    '&:hover': {
      borderBottom: 'none',
    },
    '&:active': {
      borderBottom: 'none',
    },
  },
  container: {
    display: 'flex',
    maxWidth: '100%',
    width: '100%',
    marginRight: 0,
    marginLeft: 0,
    padding: 0,
    backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[6] : theme.white,
    height: 'fit-content',
    color: theme.colorScheme === 'dark' ? theme.colors.dark[0] : theme.black,
    borderBottom: `${rem(1)} solid ${theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]}`,
  },
}));

export default Header;
