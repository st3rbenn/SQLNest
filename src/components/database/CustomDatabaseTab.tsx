import { Flex, Text, createStyles } from '@mantine/core';
import React from 'react';
import { TbDatabase } from 'react-icons/tb';
import { useAppThunkDispatch } from '../../store';
import { useDatabase } from '../../store/mainslice';

type CustomDatabaseTabProps = {
  name: string;
};

const CustomDatabaseTab = (props: CustomDatabaseTabProps) => {
  const { name } = props;
  const { classes } = useStyles();
  const dispatch = useAppThunkDispatch();

  const handleSelectDatabase = async () => {
    const res = await dispatch(useDatabase(name));

    if(res.meta.requestStatus === 'fulfilled') {
      console.log('Database selected');
    }
  };

  return (
    <Flex className={classes.database} onClick={handleSelectDatabase}>
      <TbDatabase size={20} color='#D0CECB' />
      <Text
        style={{
          fontSize: 12,
          color: '#D0CECB',
          marginLeft: 10,
        }}>
        {name}
      </Text>
    </Flex>
  );
};

const useStyles = createStyles((theme) => ({
  database: {
    color: theme.colorScheme === 'dark' ? theme.colors.white : theme.white,
    fontWeight: 700,
    alignItems: 'center',
    display: 'inline-flex',
    borderRadius: theme.radius.sm,
    fontSize: '.7rem',
    padding: '.2rem .5rem',
    cursor: 'pointer',
    '&:hover': {
      backgroundColor: theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.black,
    },
  },
}));

export default CustomDatabaseTab;
